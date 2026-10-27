import https from 'node:https';
import { createLoopbackTestTlsMaterial } from './loopback-test-tls.mjs';
import { startNativeAgreementChain } from './native-agreement-payment-harness.mjs';

const listen=(server)=>new Promise((resolve)=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close=(server)=>new Promise((resolve)=>{server.closeAllConnections();server.close(resolve);});

export async function startOperatorNode2({tlsFixture=null,nativeFees=null}={}){
  const {key,cert}=tlsFixture??createLoopbackTestTlsMaterial();
  const chain=await startNativeAgreementChain({nativeFees}),blockEpoch=Math.floor(Date.now()/1000);
  const server=https.createServer({key,cert},async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const parsed=body?JSON.parse(body):null;
    const upstream=await fetch(`${chain.url}${req.url}`,{method:req.method,headers:{'content-type':'application/json',...(req.headers.identity?{identity:req.headers.identity,signature:req.headers.signature,timestamp:req.headers.timestamp}:{})},...(body?{body}:{})});
    const data=await upstream.json();
    if(parsed?.params?.[0]?.message==='getTransactionStatus'){
      const number=chain.inclusion.numberFor(parsed.params[0].data.hash);if(Number.isSafeInteger(number))data.response={state:'included',blockNumber:number};
    }
    if(parsed?.params?.[0]?.message==='getBlockByNumber'&&data.response?.content&&Number.isSafeInteger(Number(data.response.number)))data.response.content.timestamp=blockEpoch+Number(data.response.number);
    if(parsed?.params?.[0]?.message==='getNetworkInfo'){delete data.response.simulated;delete data.response.chainIdentity;}
    res.writeHead(upstream.status,{'content-type':'application/json',connection:'close'});res.end(JSON.stringify(data));
  });
  const endpoint=`https://127.0.0.1:${await listen(server)}/`;
  const fetchImpl=(url,options={})=>new Promise((resolve,reject)=>{
    const request=https.request(url,{method:options.method,headers:options.headers,ca:cert,signal:options.signal,agent:false},response=>{const chunks=[];response.on('data',(chunk)=>chunks.push(chunk));response.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers:response.headers})));response.on('error',reject);});
    request.on('error',reject);request.end(options.body);
  });
  return{endpoint,fetchImpl,key,cert,chain,close:async()=>{await close(server);await chain.close();}};
}

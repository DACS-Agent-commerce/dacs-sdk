// List installed production packages whose engines.node range does not cover the consumer's advertised range.
const fs=require('node:fs');
const path=require('node:path');
const npmRoot=process.argv[4]||path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm');
const Arborist=require(path.join(npmRoot,'node_modules/@npmcli/arborist'));
const semver=require(path.join(npmRoot,'node_modules/semver'));
// Advertised range floors, the generated Docker base image (node:20.19.1), the last 22.x release before 22.22.2,
// the first 23.x, 24.x and 25.x releases and the last 24.x minor before 24.15.0.
const PROBES=['20.19.0','20.19.1','22.12.0','22.22.1','23.0.0','24.0.0','24.14.0','25.0.0'];
(async()=>{
  const root=process.argv[2];
  const output=process.argv[3];
  if(!root||!output)throw new Error('Usage: engines-check.cjs <consumer-root> <output> [npm-root]');
  const tree=await new Arborist({path:root,forceActual:true}).loadActual();
  const advertised=tree.package.engines?.node;
  if(typeof advertised!=='string'||!semver.validRange(advertised))throw new Error('Consumer root has no valid engines.node range.');
  const nodes=[...await tree.querySelectorAll(':root *:not(.dev)')].filter(n=>!n.isLink).sort((a,b)=>a.location.localeCompare(b.location));
  const outside=[];
  for(const node of nodes){
    const range=node.package.engines?.node;
    if(range===undefined)continue;
    // engine-strict rejects a range it cannot parse, so an invalid range is outside too.
    const valid=typeof range==='string'&&semver.validRange(range)!==null;
    if(valid&&semver.subset(advertised,range))continue;
    outside.push({location:node.location,name:node.packageName,version:node.version,engines_node:range,
      rejected_probes:PROBES.filter(v=>!valid||!semver.satisfies(v,range))});
  }
  const result={advertised,probes:PROBES,checked:nodes.length,outside};
  fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
  process.stdout.write(JSON.stringify({checked:nodes.length,outside:outside.length})+'\n');
  if(outside.length)process.exitCode=1;
})().catch(e=>{process.stderr.write(String(e)+'\n');process.exitCode=2;});

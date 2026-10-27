import { canonicalize, contentHash, isCanonicalJobId } from '@kynesyslabs/dacs';
import { MAX_STORAGE_ARTIFACT_BYTES } from '../dacs/wallet-transactions.mjs';

const REPORT_TEXT_MAX_BYTES = 16_384;
const reportTextValid = text => typeof text === 'string' && text.length > 0 && text.length <= REPORT_TEXT_MAX_BYTES &&
  Buffer.byteLength(text, 'utf8') <= REPORT_TEXT_MAX_BYTES && text.normalize('NFC') === text &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(text);
// A report is published whole in one storage CREATE, so its complete canonical
// bytes, not only its text, must fit that CREATE's limit.
const reportFitsOneCreate = report => Buffer.byteLength(canonicalize(report), 'utf8') <= MAX_STORAGE_ARTIFACT_BYTES;

export const DEVNET_PURCHASED_REPORT_KIND='dacs-chatgpt-plugin/devnet-purchased-report';

// A genuine application producer: the supplied service function creates the
// purchased bytes from the bound purchase facts. No fixture report, success
// Boolean, or seller HTTP response can substitute for these returned bytes.
export function createDevnetPurchasedReportProducer({producer,produce}) {
  if(typeof producer!=='string' || !/^did:demos:agent:[0-9a-f]{64}$/.test(producer) || typeof produce!=='function') throw new TypeError('a seller identity and purchased-content producer are required');
  return ({agreement,listing,settlementId})=>{
    if(!isCanonicalJobId(agreement?.jobId)) throw new TypeError('jobId must be a canonical uppercase ULID');
    const result=produce(structuredClone({agreement,listing,settlementId}));
    if(result && typeof result.then==='function') throw new TypeError('the durable seller producer must return deterministic bytes synchronously');
    const text=typeof result==='string' ? result : result?.mediaType==='text/plain; charset=utf-8' && typeof result.text==='string' ? result.text : null;
    if(!reportTextValid(text)) throw new TypeError('the purchased report must be bounded UTF-8 text');
    const report=JSON.parse(canonicalize({reportVersion:'1',kind:DEVNET_PURCHASED_REPORT_KIND,jobId:agreement.jobId,
      agreementHash:contentHash(agreement),listing:{...agreement.listingRef},title:listing.offering.title,settlementId,producer,
      content:{mediaType:'text/plain; charset=utf-8',text}}));
    if(!isDevnetPurchasedReport(report,{jobId:agreement.jobId,producer})) throw new TypeError(`the purchased report must pass the report predicate and fit one storage CREATE (${MAX_STORAGE_ARTIFACT_BYTES} canonical bytes)`);
    return report;
  };
}

export function isDevnetPurchasedReport(value,{jobId,agreementHash,producer}={}) {
  return value?.reportVersion==='1' && value.kind===DEVNET_PURCHASED_REPORT_KIND
    && value!==null && typeof value==='object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',')==='agreementHash,content,jobId,kind,listing,producer,reportVersion,settlementId,title'
    && isCanonicalJobId(value.jobId) && typeof value.agreementHash==='string' && /^[0-9a-f]{64}$/.test(value.agreementHash)
    && value.listing!==null && typeof value.listing==='object' && !Array.isArray(value.listing)
    && Object.keys(value.listing).sort().join(',')==='contentHash,listingId,version'
    && typeof value.listing.listingId==='string' && Number.isSafeInteger(value.listing.version) && /^[0-9a-f]{64}$/.test(value.listing.contentHash ?? '')
    && typeof value.settlementId==='string' && value.settlementId.length>0
    && typeof value.title==='string' && value.title.length>0 && value.title.length<=512
    && /^did:demos:agent:[0-9a-f]{64}$/.test(value.producer ?? '')
    && value.content?.mediaType==='text/plain; charset=utf-8' && Object.keys(value.content).sort().join(',')==='mediaType,text'
    && reportTextValid(value.content.text) && reportFitsOneCreate(value)
    && (jobId===undefined || value.jobId===jobId) && (agreementHash===undefined || value.agreementHash===agreementHash) && (producer===undefined || value.producer===producer);
}

// Match audit node versions to exact source ranges with the semver copy bundled by the collection npm.
const fs=require('node:fs');
const path=require('node:path');
// npm 10.9.9, recorded in manifest.json as the install/pack/audit npm, bundles semver 7.7.4.
const PINNED='7.7.4';
const npmRoot=process.argv[2]||path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm');
const folder=path.join(npmRoot,'node_modules/semver');
const version=JSON.parse(fs.readFileSync(path.join(folder,'package.json'),'utf8')).version;
if(version!==PINNED){
  process.stderr.write('semver '+version+' found under the npm root; '+PINNED+' (bundled by npm 10.9.9) is required. Pass that npm root as the first argument.\n');
  process.exit(1);
}
const semver=require(folder);
const jobs=JSON.parse(fs.readFileSync(0,'utf8'));
if(Array.isArray(jobs)){
  process.stdout.write(JSON.stringify(jobs.map(job=>job.versions.map(v=>job.inherited||semver.satisfies(v,job.range,{includePrerelease:true})))));
}else if(jobs.canonical_versions){
  // npm's CycloneDX formatter canonicalizes loose manifest versions (for example 1.0.01 -> 1.0.1).
  process.stdout.write(JSON.stringify(jobs.canonical_versions.map(v=>semver.clean(v,{loose:true})||v)));
}else{
  // Convert comparator sets to unions of half-open intervals of stable versions. Merge adjacent intervals:
  // semver.subset alone cannot prove containment when a single range spans several union alternatives.
  const compare=(a,b)=>a===b?0:a===null?1:b===null?-1:semver.compare(a,b);
  const min=(a,b)=>compare(a,b)<0?a:b;
  const max=(a,b)=>compare(a,b)>0?a:b;
  function intervals(range){
    const result=[];
    for(const set of new semver.Range(range).set){
      let lower='0.0.0',upper=null;
      for(const c of set){
        if(!c.value)continue;
        const v=c.semver;
        const base=`${v.major}.${v.minor}.${v.patch}`;
        const next=`${v.major}.${v.minor}.${v.patch+1}`;
        const pre=v.prerelease.length>0;
        if(c.operator==='>='||c.operator==='>')lower=max(lower,c.operator==='>'&&!pre?next:base);
        else if(c.operator==='<'||c.operator==='<=')upper=min(upper,c.operator==='<='&&!pre?next:base);
        else {lower=max(lower,base);upper=min(upper,pre?base:next);}
      }
      if(compare(lower,upper)<0)result.push([lower,upper]);
    }
    result.sort((a,b)=>compare(a[0],b[0]));
    const merged=[];
    for(const interval of result){
      const last=merged.at(-1);
      if(last&&compare(interval[0],last[1])<=0)last[1]=max(last[1],interval[1]);
      else merged.push(interval);
    }
    return merged;
  }
  function intersection(a,b){
    return a.flatMap(x=>b.map(y=>[max(x[0],y[0]),min(x[1],y[1])])).filter(x=>compare(x[0],x[1])<0);
  }
  const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const result=jobs.trees.map(tree=>{
    const ranges=[...new Set([tree.advertised,...tree.outside.map(r=>r.engines_node)])];
    const advertised=intervals(tree.advertised);
    const expected=ranges.reduce((soFar,range)=>intersection(soFar,intervals(range)),[['0.0.0',null]]);
    return {
      rejected_probes:tree.outside.map(row=>jobs.probes.filter(v=>!semver.satisfies(v,row.engines_node))),
      outside:tree.outside.map(row=>!equal(advertised,intersection(advertised,intervals(row.engines_node)))),
      effective_range_equal:equal(intervals(tree.effective_node_range),expected),
    };
  });
  process.stdout.write(JSON.stringify(result));
}

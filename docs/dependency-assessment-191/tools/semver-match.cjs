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
process.stdout.write(JSON.stringify(jobs.map(job=>job.versions.map(v=>job.inherited||semver.satisfies(v,job.range,{includePrerelease:true})))));

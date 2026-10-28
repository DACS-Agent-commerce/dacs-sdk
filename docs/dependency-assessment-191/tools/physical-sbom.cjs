const fs=require('node:fs');
const path=require('node:path');
const npmRoot=process.argv[4]||path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm');
const Arborist=require(path.join(npmRoot,'node_modules/@npmcli/arborist'));
const {cyclonedxOutput}=require(path.join(npmRoot,'lib/utils/sbom-cyclonedx.js'));
(async()=>{
  const root=process.argv[2];
  const folder=process.argv[3];
  if(!root||!folder)throw new Error('Usage: physical-sbom.cjs <consumer-root> <output-directory> [npm-root]');
  const tree=await new Arborist({path:root,forceActual:true}).loadActual();
  const nodes=await tree.querySelectorAll(':root,:root *:not(.dev),:extraneous');
  const conflicts=[];
  const inventory=[];
  for(const node of nodes){
    inventory.push({location:node.location,name:node.packageName,version:node.version,dev:node.dev,optional:node.optional,integrity:node.integrity||null});
    for(const edge of node.edgesOut.values()){
      if(edge.invalid||edge.missing&&!['optional','peerOptional'].includes(edge.type)){
        conflicts.push({from:node.location,name:edge.name,type:edge.type,expected:edge.spec,target:edge.to?.location||null,installed:edge.to?.version||null,error:edge.error});
      }
    }
  }
  fs.writeFileSync(folder+'/physical-inventory.json',JSON.stringify(inventory,null,2)+'\n');
  fs.writeFileSync(folder+'/physical-range-conflicts.json',JSON.stringify(conflicts,null,2)+'\n');
  const sbom=cyclonedxOutput({npm:{version:require(path.join(npmRoot,'package.json')).version},nodes,packageLockOnly:false});
  fs.writeFileSync(folder+'/sbom-physical.cdx.json',JSON.stringify(sbom,null,2)+'\n');
  const refByLocation=new Map(nodes.map(node=>[node.location,node.isRoot?'npm:root':'npm:'+node.location]));
  sbom.metadata.component['bom-ref']='npm:root';
  for(const component of sbom.components){
    const location=component.properties.find(p=>p.name==='cdx:npm:package:path').value;
    component['bom-ref']=refByLocation.get(location);
  }
  sbom.dependencies=nodes.filter(n=>!n.isLink).map(node=>({ref:refByLocation.get(node.location),dependsOn:[...new Set([...node.edgesOut.values()].map(edge=>edge.to&&refByLocation.get(edge.to.location)).filter(Boolean))]}));
  sbom.metadata.tools.push({vendor:'S-55 assessment',name:'physical-instance-export',version:'1'});
  sbom.metadata.properties=[{name:'s55:range-conflicts',value:JSON.stringify(conflicts)},{name:'s55:scope',value:'Installed production instances; dev omitted; original range conflicts retained. This is a supplementary export, not a successful npm sbom CLI run.'}];
  for(const component of [sbom.metadata.component,...sbom.components]){
    for(const reference of component.externalReferences||[]){
      if(reference.url.startsWith('file:')&&reference.url.endsWith('.tgz'))reference.url='file:tarballs/'+path.basename(reference.url);
    }
    // CycloneDX 1.5 license.id admits only SPDX list identifiers; user-defined references belong in license.name.
    for(const entry of component.licenses||[]){
      if(/^(?:LicenseRef|DocumentRef)-/.test(entry.license?.id||''))entry.license={name:entry.license.id};
    }
  }
  fs.writeFileSync(folder+'/sbom-installed.cdx.json',JSON.stringify(sbom,null,2)+'\n');
  process.stdout.write(JSON.stringify({components:sbom.components.length,conflicts:conflicts.length})+'\n');
})().catch(e=>{process.stderr.write(String(e)+'\n');process.exitCode=1;});

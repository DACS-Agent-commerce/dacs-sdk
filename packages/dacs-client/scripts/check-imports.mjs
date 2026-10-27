#!/usr/bin/env node
import ts from 'typescript';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const pkg=join(dirname(fileURLToPath(import.meta.url)),'..');
const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(x=>x.isDirectory()?walk(join(dir,x.name)):[join(dir,x.name)]);
export function importAudit() {
 const rows=[],failures=[];
 for(const file of walk(join(pkg,'src'))) {
  const sf=ts.createSourceFile(file,readFileSync(file,'utf8'),99,true,ts.ScriptKind.JS);
  const visit=n=>{if((ts.isImportDeclaration(n)||ts.isExportDeclaration(n))&&n.moduleSpecifier){
   const spec=n.moduleSpecifier.text,where=relative(pkg,file)+':'+(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1);
   if(spec.includes('node_modules')||spec.includes('/dist/')||/operations\.mjs|buyer-access\.mjs|wallet\/demos-signature|public\/portal\//.test(spec)) failures.push(`${where}: forbidden import ${spec}`);
   if(spec.startsWith('.')) {
    const target=resolve(dirname(file),spec);
    if(!target.startsWith(resolve(pkg,'src')+'/')||!existsSync(target))failures.push(`${where}: missing/outside dependency ${spec}`);
    rows.push({where,spec,target:relative(pkg,target)});
   }
  }ts.forEachChild(n,visit);};visit(sf);
 }
 return {rows,failures};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
 const {rows,failures}=importAudit();
 for(const f of failures)console.error('FAIL '+f);
 console.log(`[check-imports] ${failures.length?'FAIL':'OK'}: ${rows.length} relative source imports; ${failures.length} cut dependencies remain`);
 process.exitCode=failures.length?1:0;
}

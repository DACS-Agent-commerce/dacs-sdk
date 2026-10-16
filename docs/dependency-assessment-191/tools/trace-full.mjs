import fs from 'node:fs';
import path from 'node:path';
import {createRequire,isBuiltin} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=process.argv[2];
const output=process.argv[3];
if(!root||!output)throw new Error('Usage: node --experimental-import-meta-resolve trace-full.mjs <consumer-root> <output> [tooling-root]');
if(!process.execArgv.includes('--experimental-import-meta-resolve')){
  throw new Error('Run node with --experimental-import-meta-resolve so imports resolve from each source file.');
}
const ts=createRequire(path.join(process.argv[4]||root,'package.json'))('typescript');
const base=path.join(root,'node_modules/@kynesyslabs/demosdk');
const seeds=['build/websdk/index.js','build/storage/index.js','build/abstraction/index.js','build/d402/client/index.js'];
const queue=seeds.map(s=>({file:path.join(base,s),chain:[path.relative(root,path.join(base,s))]}));
const files={},packages={},unresolved=[],deferred=[],nonliteral=[],edges=[];
const visited=new Set();
const ownerCache=new Map();
function owner(file){
  if(ownerCache.has(file))return ownerCache.get(file);
  let dir=path.dirname(file);
  while(dir.startsWith(root)){
    const p=path.join(dir,'package.json');
    // Nameless manifests are module-type stubs inside a package (for example lib.esm/); keep walking to the installed package.
    const m=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):null;
    if(m?.name){
      const value={location:path.relative(root,dir),name:m.name,version:m.version};
      ownerCache.set(file,value);return value;
    }
    const parent=path.dirname(dir);if(parent===dir)break;dir=parent;
  }
}
function resolve(source,specifier,kind){
  let file;
  try{
    file=kind==='require'?createRequire(source).resolve(specifier):fileURLToPath(import.meta.resolve(specifier,pathToFileURL(source).href));
  }catch(error){
    if(!specifier.startsWith('.'))try{file=createRequire(source).resolve(specifier);}catch{}
    else file=path.resolve(path.dirname(source),specifier);
  }
  if(!file)return null;
  for(const candidate of [file,file+'.js',file+'.json',file+'.cjs',path.join(file,'index.js')]){
    if(fs.existsSync(candidate)&&fs.statSync(candidate).isFile())return candidate;
  }
  return null;
}
while(queue.length){
  const {file,chain}=queue.shift();
  if(visited.has(file))continue;
  visited.add(file);
  if(visited.size>30000)throw new Error('trace file cap exceeded');
  if(!fs.existsSync(file)){unresolved.push({source:path.relative(root,file),specifier:null});continue;}
  const relative=path.relative(root,file);
  const pkg=owner(file);
  files[relative]={package:pkg,chain};
  if(pkg&&!packages[pkg.location])packages[pkg.location]={...pkg,chain};
  if(!/\.(?:mjs|cjs|js)$/.test(file))continue;
  const source=fs.readFileSync(file,'utf8');
  const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const imports=[];
  function walk(n){
    if((ts.isImportDeclaration(n)||ts.isExportDeclaration(n))&&n.moduleSpecifier&&ts.isStringLiteral(n.moduleSpecifier)){
      imports.push({specifier:n.moduleSpecifier.text,kind:ts.isImportDeclaration(n)?'import':'reexport',line:ast.getLineAndCharacterOfPosition(n.getStart()).line+1});
    }
    if(ts.isCallExpression(n)&&n.arguments.length){
      const a=n.arguments[0];
      if(n.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(n.expression)&&n.expression.text==='require'){
        const entry={specifier:ts.isStringLiteralLike(a)?a.text:null,kind:n.expression.kind===ts.SyntaxKind.ImportKeyword?'dynamic-import':'require',line:ast.getLineAndCharacterOfPosition(n.getStart()).line+1};
        if(entry.kind==='dynamic-import')deferred.push({source:relative,...entry});
        else if(entry.specifier===null)nonliteral.push({source:relative,...entry});
        else imports.push(entry);
      }
    }
    ts.forEachChild(n,walk);
  }
  walk(ast);
  for(const entry of imports){
    if(isBuiltin(entry.specifier))continue;
    const target=resolve(file,entry.specifier,entry.kind);
    edges.push({source:relative,...entry,target:target?path.relative(root,target):null});
    if(target)queue.push({file:target,chain:[...chain,path.relative(root,target)]});
    else unresolved.push({source:relative,...entry});
  }
}
fs.writeFileSync(output,JSON.stringify({seeds,files,packages,unresolved,deferred,nonliteral,edges},null,2)+'\n');
process.stdout.write(JSON.stringify({files:visited.size,packages:Object.keys(packages).length,unresolved,deferredCount:deferred.length,nonliteralCount:nonliteral.length})+'\n');
if(unresolved.some(entry=>entry.specifier===null||entry.specifier.startsWith('.'))){
  process.stderr.write('Trace incomplete: a seed file or relative import could not be resolved.\n');
  process.exitCode=1;
}

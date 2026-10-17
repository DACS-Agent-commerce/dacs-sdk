import fs from 'node:fs';
import path from 'node:path';
import {createRequire,isBuiltin} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=process.argv[2];
const out=process.argv[3];
const packageName=process.argv[4]||'@kynesyslabs/demosdk';
if(!root||!out)throw new Error('Usage: trace-imports.mjs <consumer-root> <output> [package] [tooling-root]');
const ts=createRequire(path.join(process.argv[5]||root,'package.json'))('typescript');
const base=path.join(root,'node_modules',packageName);
const seeds=packageName==='@kynesyslabs/demosdk'?['build/websdk/index.js','build/storage/index.js','build/abstraction/index.js','build/d402/client/index.js']:['dist/index.js','dist/storage.js','dist/identity-read.js'];
const edges=[],unresolved=[],external={},files={},dynamic=[];
const queue=seeds.map(s=>({file:path.join(base,s),chain:[s],seed:s}));
const visited=new Set();
function resolveRelative(source,specifier){
  const p=path.resolve(path.dirname(source),specifier);
  for(const candidate of [p,p+'.js',p+'.cjs',p+'.mjs',path.join(p,'index.js')]){
    if(fs.existsSync(candidate)&&fs.statSync(candidate).isFile())return candidate;
  }
}
while(queue.length){
  const {file,chain,seed}=queue.shift();
  if(visited.has(file))continue;
  visited.add(file);
  if(!fs.existsSync(file)){unresolved.push({file,specifier:null});continue;}
  const source=fs.readFileSync(file,'utf8');
  files[path.relative(base,file)]={bytes:Buffer.byteLength(source)};
  const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const imports=[];
  function walk(n){
    if((ts.isImportDeclaration(n)||ts.isExportDeclaration(n))&&n.moduleSpecifier&&ts.isStringLiteral(n.moduleSpecifier)){
      imports.push({specifier:n.moduleSpecifier.text,kind:ts.isImportDeclaration(n)?'import':'reexport',line:ast.getLineAndCharacterOfPosition(n.getStart()).line+1});
    }
    if(ts.isCallExpression(n)&&n.arguments.length){
      const a=n.arguments[0];
      if(n.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(n.expression)&&n.expression.text==='require'){
        const item={specifier:ts.isStringLiteralLike(a)?a.text:null,kind:n.expression.kind===ts.SyntaxKind.ImportKeyword?'dynamic-import':'require',line:ast.getLineAndCharacterOfPosition(n.getStart()).line+1};
        if(item.kind==='dynamic-import'||item.specifier===null)dynamic.push({source:path.relative(base,file),...item});
        else imports.push(item);
      }
    }
    ts.forEachChild(n,walk);
  }
  walk(ast);
  for(const entry of imports){
    const {specifier}=entry;
    edges.push({source:path.relative(base,file),...entry});
    if(specifier.startsWith('.')){
      const target=resolveRelative(file,specifier);
      if(target)queue.push({file:target,chain:[...chain,path.relative(base,target)],seed});
      else unresolved.push({source:path.relative(base,file),...entry});
    }else if(!isBuiltin(specifier)){
      let resolved;
      try{resolved=createRequire(file).resolve(specifier);}catch(error){resolved=null;unresolved.push({source:path.relative(base,file),...entry,error:error.code});}
      if(!external[specifier])external[specifier]={chain:[...chain,specifier],source:path.relative(base,file),line:entry.line,resolved:resolved?path.relative(root,resolved):null,seed};
    }
  }
}
fs.writeFileSync(out,JSON.stringify({package:packageName,version:JSON.parse(fs.readFileSync(path.join(base,'package.json'),'utf8')).version,seeds,files,edges,external,dynamic,unresolved},null,2)+'\n');
process.stdout.write(JSON.stringify({files:visited.size,external:Object.keys(external),dynamic,unresolved},null,2)+'\n');

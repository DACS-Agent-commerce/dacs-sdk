// The minimal text-node DOM used by portal-delivery-evidence-label, extended
// with events and selectors to drive the shipped purchase and wallet UIs.
export class Node{
  constructor(tag){this.tag=tag;this.children=[];this.attributes={};this.dataset={};this.events=new Map();this.value='';this.classList={add(){},remove(){}};}
  append(...items){for(const item of items){item.parent=this;this.children.push(item);}}
  replaceChildren(...items){this.children=[];this.append(...items);}
  setAttribute(k,v){this.attributes[k]=String(v);if(k.startsWith('data-'))this.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=String(v);}
  addEventListener(k,fn){this.events.set(k,[...(this.events.get(k)??[]),fn]);}
  removeEventListener(k,fn){this.events.set(k,(this.events.get(k)??[]).filter(f=>f!==fn));}
  async fire(k,event={}){for(const fn of this.events.get(k)??[])await fn({preventDefault(){},...event});}
  get text(){return this.tag==='#text'?this.value:this.children.map(child=>child.text).join('');}
  set textContent(value){this.replaceChildren(Object.assign(new Node('#text'),{value:String(value)}));}
  get textContent(){return this.text;}
  set innerHTML(_value){throw new Error('HTML rendering is forbidden');}
  matches(selector){const m=/^(\w+)?(?:\[([^=\]]+)(?:="?([^"\]]+)"?)?\])?$/.exec(selector.trim());return Boolean(m&&(!m[1]||this.tag===m[1])&&(!m[2]||Object.hasOwn(this.attributes,m[2])&&(!m[3]||this.attributes[m[2]]===m[3])));}
  querySelectorAll(selector){const found=[];for(const child of this.children){if(selector.split(',').some(s=>child.matches(s)))found.push(child);found.push(...child.querySelectorAll(selector));}return found;}
  querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
  focus(){}
  showModal(){this.open=true;}
  close(){this.open=false;}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);}
}
export function fakeDocument(){
  const document=new Node('document'),ids=new Map();
  document.hidden=false;document.head=new Node('head');document.append(document.head);
  // portal.js reads the shell's report switch (data-showcase-report-view) from body.
  document.body=new Node('body');
  document.createElement=tag=>new Node(tag);
  document.createTextNode=value=>Object.assign(new Node('#text'),{value});
  document.getElementById=id=>{if(!ids.has(id)){const node=new Node('section');node.setAttribute('id',id);ids.set(id,node);document.append(node);}return ids.get(id);};
  return document;
}
export function fakeClock(){
  let time=0,seq=0;const timers=new Map();
  return{now:()=>time,timers,setTimer:(fn,ms)=>{const id=++seq;timers.set(id,{fn,ms,at:time+ms});return id;},clearTimer:id=>timers.delete(id),
    async advance(ms,fire=true){time+=ms;if(fire)for(const [id,timer] of [...timers])if(timer.at<=time){timers.delete(id);await timer.fn();}await flush();}};
}
export const flush=()=>new Promise(resolve=>setImmediate(resolve));

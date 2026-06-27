import { parsePyret } from "./src/parser/pyret-parser.ts";
const cst = await parsePyret("let x = 5: x + 1 end\n");
function find(n:any,nm:string):any{if(n.name===nm)return n;for(const k of n.kids||[]){const r=find(k,nm);if(r)return r;}return null;}
const mle=find(cst,"multi-let-expr");
function show(n:any,d=0):string{const v=n.value!==undefined?` =${JSON.stringify(n.value)}`:"";return "  ".repeat(d)+n.name+v+"\n"+(n.kids||[]).map((k:any)=>show(k,d+1)).join("");}
console.log(show(mle));

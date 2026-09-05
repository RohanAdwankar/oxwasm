// Walk the guest's frame-pointer chain at fault time and name each return
// address against nm symbol tables, so the phase of a guest crash is read off
// rather than inferred.
//
// Written because inference had already produced one wrong answer about the
// CPython crash and then one wrong correction to it. The stack settles in a
// single run what two rounds of reasoning from the fault address did not.
//
//   node tools/gueststack.mjs -S -c pass
//
// Hardcoded to /usr/bin/python3 today; the symbol resolution and rbp walk are
// general and worth lifting out when a second guest needs them.
import { LinuxEngine } from '/home/user/0/oxwasm/engine/linux.mjs';
import { readFileSync, readdirSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const files={},mtimes={};
const add=(g,h)=>{try{files[g]=new Uint8Array(readFileSync(h));mtimes[g]=Math.floor(statSync(h).mtimeMs/1000);}catch{}};
const walk=(d)=>{let e;try{e=readdirSync(d)}catch{return}
 for(const f of e){const hp=join(d,f);let st;try{st=lstatSync(hp)}catch{continue}
  if(st.isDirectory())walk(hp);else{try{add(hp,realpathSync(hp))}catch{}}}};
for(const d of ['/lib/x86_64-linux-gnu','/usr/lib/x86_64-linux-gnu','/lib64']){let e;try{e=readdirSync(d)}catch{continue}
 for(const f of e){try{const r=realpathSync(join(d,f));if(lstatSync(r).isFile())add(join(d,f),r)}catch{}}}
add('/etc/ld.so.cache','/etc/ld.so.cache'); walk('/usr/lib/python3.11');
const bin='/usr/bin/python3'; add(bin,bin);

// symbol tables, per file, sorted by value
const symCache=new Map();
const syms=(path)=>{
  if(symCache.has(path)) return symCache.get(path);
  let out=''; for(const flag of ['-n','--dynamic -n']) {
    try { out = execFileSync('bash',['-c',`nm ${flag} --defined-only ${path} 2>/dev/null`],{encoding:'utf8',maxBuffer:64e6}); }
    catch {}
    if(out.trim()) break;
  }
  const list=[];
  for(const l of out.split('\n')){ const m=/^([0-9a-f]+)\s+\S\s+(.+)$/.exec(l); if(m) list.push([BigInt('0x'+m[1]), m[2]]); }
  list.sort((a,b)=> a[0]<b[0]?-1:a[0]>b[0]?1:0);
  symCache.set(path,list); return list;
};
const name=(eng,addr)=>{
  for(const m of (eng.maps||[])) if(addr>=m.at && addr<m.at+m.len){
    const off=addr-m.at + (m.off??0n);
    const list=syms(m.path); let lo=0,hi=list.length-1,best=null;
    while(lo<=hi){const mid=(lo+hi)>>1; if(list[mid][0]<=off){best=list[mid];lo=mid+1}else hi=mid-1;}
    return `${m.path.split('/').pop()}+0x${off.toString(16)}` + (best?` (${best[1]}+0x${(off-best[0]).toString(16)})`:'');
  }
  // main binary is not in maps: it is loaded directly
  const list=syms(bin); let lo=0,hi=list.length-1,best=null;
  while(lo<=hi){const mid=(lo+hi)>>1; if(list[mid][0]<=addr){best=list[mid];lo=mid+1}else hi=mid-1;}
  return `python3+0x${addr.toString(16)}` + (best?` (${best[1]}+0x${(addr-best[0]).toString(16)})`:'');
};

const eng=new LinuxEngine(new Uint8Array(readFileSync(bin)),
 {argv:[bin,...process.argv.slice(2)],env:['PATH=/usr/bin:/bin','LANG=C','HOME=/root'],files,mtimes,memMB:1024});
let err=null;
try{ while(eng.exitCode===null){eng.run(5e6);if(eng.blocked)eng.wake();} }catch(e){err=e.message;}
console.log('fault:',err,'@rip',eng.cpu.rip.toString(16),'insns',eng.stats.interpreted);
console.log('  rip ->', name(eng,eng.cpu.rip));
let rbp=eng.cpu.regs[5];
for(let i=0;i<20;i++){
  let ret,next;
  try{ next=eng.mem.read(rbp,8n); ret=eng.mem.read(rbp+8n,8n); }catch{ break; }
  if(!ret||ret>0x800000000n) break;
  console.log(`  #${i} ret ${ret.toString(16)} -> ${name(eng,ret)}`);
  if(next<=rbp||next===0n) break;
  rbp=next;
}

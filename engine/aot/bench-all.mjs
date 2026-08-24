// M3 AOT demonstration: compile four unmodified x86-64 binaries to wasm,
// prove each is bit-exact against the interpreter oracle, and report AOT
// wasm time next to the native binary's time for the identical function.
import { LinuxEngine } from '../linux.mjs';
import { compileFunctionWat } from '../aot_wat.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const RIDX = { rax:0, rcx:1, rdx:2, rbx:3, rsp:4, rbp:5, rsi:6, rdi:7 };
function symAddr(bin, s){ return BigInt('0x'+execFileSync('bash',['-c',`nm ${bin} | awk '/ T ${s}$/{print $1}'`]).toString().trim()); }

// each entry: how to place args + fill data for a given N
const CASES = [
  { bin:'/tmp/kernels_s', sym:'fnv1a',        native:1.257, N:1048576n, oracleN:65536n, kind:'bytes',
    args:(r,n,buf)=>{ r[RIDX.rdi]=buf; r[RIDX.rsi]=n; } },
  { bin:'/tmp/kernels_s', sym:'saxpy_sum',    native:0.540, N:1048576n, oracleN:65536n, kind:'i32x2',
    args:(r,n,buf)=>{ r[RIDX.rdi]=buf; r[RIDX.rsi]=buf+n*4n; r[RIDX.rdx]=n; r[RIDX.rcx]=7n; } },
  { bin:'/tmp/kernels_s', sym:'collatz_total',native:25.08, N:200000n, oracleN:3000n, kind:'none',
    args:(r,n,buf)=>{ r[RIDX.rdi]=n; } },
  // md5_blocks(st*, data*, nblocks): st holds the 4-word IV in/out; N is #blocks.
  { bin:'aot/md5-native', sym:'md5_blocks', native:157.8, N:1048576n, oracleN:1024n, kind:'md5',
    args:(r,n,buf)=>{ r[RIDX.rdi]=buf; r[RIDX.rsi]=buf+64n; r[RIDX.rdx]=n; },
    out:{ addr:(buf)=>buf, len:16 } },
];
function fill(e, kind, n, buf){ const off=Number(buf-e.base); const dv=new DataView(e.wmem.buffer);
  if(kind==='bytes') for(let i=0;i<Number(n);i++) e.ram[off+i]=(i*2654435761>>>24)&0xff;
  else if(kind==='i32x2') for(let i=0;i<Number(n);i++){ dv.setInt32(e.RAMOFF+off+i*4,(i*2654435761)|0,true); dv.setInt32(e.RAMOFF+off+Number(n)*4+i*4,i-3,true);}
  else if(kind==='md5'){ const IV=[0x67452301,0xefcdab89,0x98badcfe,0x10325476]; IV.forEach((w,i)=>dv.setUint32(e.RAMOFF+off+i*4,w,true));
    const bytes=Number(n)*64; for(let i=0;i<bytes;i++) e.ram[off+64+i]=(i*2654435761>>>24)&0xff; } }
const rdOut=(e,addr,len)=>{ const off=Number(addr-e.base); let s=''; for(let i=0;i<len;i++) s+=e.ram[off+i].toString(16).padStart(2,'0'); return s; };

console.log('kernel          native(ms)  AOT-wasm(ms)   ratio   correctness');
console.log('----------------------------------------------------------------');
for (const c of CASES) {
  const elf = new Uint8Array(readFileSync(c.bin));
  const entry = symAddr(c.bin, c.sym);
  const mk = () => new LinuxEngine(elf, { argv:['k'], files:{}, memMB:1024 });
  const eng = mk();
  const { wat, entryName } = compileFunctionWat(eng.mem, entry, { guestBase:eng.base, ramBase:eng.RAMOFF });
  writeFileSync('/tmp/ba.wat', wat); execFileSync('wat2wasm',['/tmp/ba.wat','-o','/tmp/ba.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/ba.wasm'));
  const buf = eng.brk, SENT = 0xdeadbee0n;
  const envStubs = { syscall(){ throw new Error('escape'); }, callout(){ throw new Error('escape'); }, deopt(){ throw new Error('escape'); } };
  // oracle
  fill(eng, c.kind, c.oracleN, buf); const cpu = eng.cpu;
  for(let r=0;r<16;r++) cpu.regs[r]=0n; cpu.regs[RIDX.rsp]=(eng.base+BigInt(eng.ram.length)-4096n)&~0xFn;
  c.args(cpu.regs, c.oracleN, buf); cpu.push(SENT); cpu.rip=entry;
  let g=0; while(cpu.rip!==SENT){ cpu.step(); if(++g>5e10) throw new Error('runaway'); }
  const oracle = c.out ? rdOut(eng, c.out.addr(buf), c.out.len) : BigInt.asUintN(64, cpu.regs[0]).toString(16);
  // AOT
  const eng2 = mk(); const inst = new WebAssembly.Instance(mod, { js:{ mem:eng2.wmem }, env: envStubs });
  const runFn = inst.exports[entryName];
  const rsp = ((eng2.base+BigInt(eng2.ram.length)-4096n)&~0xFn) - 8n;      // sentinel slot
  new DataView(eng2.wmem.buffer).setBigUint64(eng2.RAMOFF+Number(rsp-eng2.base), SENT, true);
  const run = (n)=>{ fill(eng2,c.kind,n,buf); const r=[]; for(let i=0;i<16;i++)r[i]=0n; r[RIDX.rsp]=rsp; c.args(r,n,buf);
    for(let i=0;i<16;i++) eng2.regview[i]=BigInt.asIntN(64,r[i]);
    if (BigInt.asUintN(64, runFn()) !== SENT) throw new Error('bad exit rip');
    return { val: c.out ? rdOut(eng2,c.out.addr(buf),c.out.len) : BigInt.asUintN(64,eng2.regview[0]).toString(16), r }; };
  const aot = run(c.oracleN).val;
  const ok = oracle===aot;
  const { r } = run(c.N);
  let best=1e18; for(let i=0;i<80;i++){ for(let k=0;k<16;k++) eng2.regview[k]=BigInt.asIntN(64,r[k]); const t=process.hrtime.bigint(); runFn(); const ns=Number(process.hrtime.bigint()-t); if(ns<best)best=ns; }
  const aotMs = best/1e6;
  console.log(`${c.sym.padEnd(15)} ${c.native.toFixed(2).padStart(9)} ${aotMs.toFixed(2).padStart(13)}   ${(aotMs/c.native).toFixed(2)}x   ${ok?'bit-exact ✓':'MISMATCH ✗'}`);
}

// Isolated differential test + timing for a single compiled function.
// Sets up args in guest memory, runs the interpreter (oracle) and the AOT
// wasm on identical inputs, compares the return value (rax), then times AOT.
import { LinuxEngine } from '../linux.mjs';
import { compileFunctionWat } from '../aot_wat.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const [binPath, sym, kind, Nstr, oracleNstr] = process.argv.slice(2);
const N = BigInt(Nstr || '1048576');
const ON = BigInt(oracleNstr || Nstr || '1048576');   // oracle can use a smaller N (interpreter is slow)
const RIDX = { rax:0, rcx:1, rdx:2, rbx:3, rsp:4, rbp:5, rsi:6, rdi:7 };
const elf = new Uint8Array(readFileSync(binPath));
const entry = BigInt('0x' + execFileSync('bash', ['-c', `nm ${binPath} | awk '/ T ${sym}$/{print $1}'`]).toString().trim());

function mkEngine(){ return new LinuxEngine(elf, { argv:['k'], files:{}, memMB: 1024 }); }
const eng = mkEngine();
const { wat, blocks, entryName } = compileFunctionWat(eng.mem, entry, { guestBase: eng.base, ramBase: eng.RAMOFF });
writeFileSync('/tmp/dk.wat', wat);
execFileSync('wat2wasm', ['/tmp/dk.wat', '-o', '/tmp/dk.wasm']);
const mod = new WebAssembly.Module(readFileSync('/tmp/dk.wasm'));
console.log(`[${sym}] ${blocks} blocks -> ${readFileSync('/tmp/dk.wasm').length} bytes wasm`);
const envStubs = { syscall(){ throw new Error('unexpected syscall escape'); },
                   callout(){ throw new Error('unexpected callout escape'); },
                   deopt(){ throw new Error('unexpected deopt escape'); } };

const buf = eng.brk;                       // scratch input region, mapped, above the ELF
const SENT = 0xdeadbee0n;
// deterministic test data
function fillData(e, n){
  const off = Number(buf - e.base);
  if (kind === 'bytes') for (let i=0;i<Number(n);i++) e.ram[off+i] = (i*2654435761 >>> 24) & 0xff;
  else if (kind === 'i32x2') { const dv = new DataView(e.wmem.buffer);
    for (let i=0;i<Number(n);i++){ dv.setInt32(e.RAMOFF+off+i*4, (i*2654435761)|0, true); dv.setInt32(e.RAMOFF+off+Number(n)*4+i*4, i-3, true); } }
}
function setArgs(regs, n){
  if (sym === 'fnv1a')       { regs[RIDX.rdi]=buf; regs[RIDX.rsi]=n; }
  else if (sym === 'saxpy_sum'){ regs[RIDX.rdi]=buf; regs[RIDX.rsi]=buf+n*4n; regs[RIDX.rdx]=n; regs[RIDX.rcx]=7n; }
  else if (sym === 'collatz_total'){ regs[RIDX.rdi]=n; }
}
// ---- oracle: interpreter ----
fillData(eng, ON);
const cpu = eng.cpu;
for (let r=0;r<16;r++) cpu.regs[r]=0n;
cpu.regs[RIDX.rsp] = (eng.base + BigInt(eng.ram.length) - 4096n) & ~0xFn;   // fresh stack high in RAM
setArgs(cpu.regs, ON);
cpu.push(SENT); cpu.rip = entry;
let guard=0; while (cpu.rip !== SENT) { cpu.step(); if (++guard>5e10) throw new Error('oracle runaway'); }
const oracle = BigInt.asUintN(64, cpu.regs[0]);

// ---- AOT correctness (same ON as the oracle) ----
const eng2 = mkEngine();
const inst = new WebAssembly.Instance(mod, { js: { mem: eng2.wmem }, env: envStubs });
const run = inst.exports[entryName];
const rsp0 = (eng2.base + BigInt(eng2.ram.length) - 4096n) & ~0xFn;
const rsp = rsp0 - 8n;                                        // sentinel return address slot
{ const dv = new DataView(eng2.wmem.buffer); dv.setBigUint64(eng2.RAMOFF + Number(rsp - eng2.base), SENT, true); }
function runAOT(n){ fillData(eng2, n); const regs=[]; for (let r=0;r<16;r++) regs[r]=0n; regs[RIDX.rsp]=rsp; setArgs(regs, n);
  for (let r=0;r<16;r++) eng2.regview[r]=BigInt.asIntN(64, regs[r]);
  const exit = BigInt.asUintN(64, run());
  if (exit !== SENT) throw new Error('AOT returned to '+exit.toString(16)+' not sentinel');
  return { rax: BigInt.asUintN(64, eng2.regview[0]), regs }; }
const aot = runAOT(ON).rax;
const ok = oracle === aot;
console.log(`[${sym}] oracle=${oracle.toString(16)}  aot=${aot.toString(16)}  (N=${ON})  ${ok?'MATCH':'*** MISMATCH ***'}`);
// timing at the (larger) N
const { regs } = runAOT(N);
let best=1e18; const iters=50;
for (let i=0;i<iters;i++){ for (let r=0;r<16;r++) eng2.regview[r]=BigInt.asIntN(64, regs[r]); const t=process.hrtime.bigint(); run(); const ns=Number(process.hrtime.bigint()-t); if(ns<best)best=ns; }
console.log(`[${sym}] AOT time (N=${N}): ${(best/1e6).toFixed(3)} ms`);
if (!ok) process.exit(1);

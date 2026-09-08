// Differential: SSE shift-by-immediate at and beyond the lane width.
//
// x86 SATURATES a vector shift whose count reaches the element width - the
// logical forms give zero, the arithmetic one gives each lane's sign bit
// repeated. wasm MASKS the count modulo the lane width, so a translated
// `psrld xmm, 32` shifted by 0 and returned the operand unchanged, and
// `psraw xmm, 17` shifted by 1.
//
// 46 of these 104 results were wrong before the emitter special-cased it.
// The interpreter was right throughout, which is what makes it a translator
// bug rather than a modelling gap - and what kept it invisible, since every
// directed vector test in this suite shifts by a count that fits.
//
// It was found by diff/fuzzaot.mjs on its first run with vector instructions
// in the generator, which is the argument for having built that.
//
// Hardware is the oracle here, not the interpreter: this is exactly the kind
// of edge where an interpreter can be confidently wrong, and the engines are
// checked against the CPU rather than against each other.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const CODE = 0x400000n, BUF = 0x420000n, SENT = 0xdeadbee0n;
const OPS = ['psllw','psrlw','psraw','pslld','psrld','psrad','psllq','psrlq'];
const COUNTS = [0, 1, 7, 15, 16, 17, 31, 32, 33, 63, 64, 65, 255];
const SEEDLO = 0x8001F0F07FFF0001n, SEEDHI = 0xFFFF8000A5A5C3C3n;
let bad = 0, n = 0;
for (const op of OPS) for (const c of COUNTS) {
  const body = `movdqu xmm0, [0x420000]\n${op} xmm0, ${c}\nmovdqu [0x420010], xmm0\nret`;
  writeFileSync('/tmp/ps.asm', 'BITS 64\n' + body);
  execFileSync('nasm', ['-f','bin','-o','/tmp/ps.bin','/tmp/ps.asm']);
  const code = new Uint8Array(0x30000); code.set(readFileSync('/tmp/ps.bin'));
  // hardware
  const C = `int main(){unsigned char b[64] __attribute__((aligned(16)));
    unsigned long long*q=(unsigned long long*)b; q[0]=0x${SEEDLO.toString(16)}ULL; q[1]=0x${SEEDHI.toString(16)}ULL;
    asm volatile("movdqu %1,%%xmm0\\n\\t${op} $${c},%%xmm0\\n\\tmovdqu %%xmm0,%0":"=m"(b[16]):"m"(b[0]):"xmm0");
    for(int i=31;i>=16;i--) __builtin_printf("%02x", b[i]); __builtin_printf("\\n"); return 0;}`;
  writeFileSync('/tmp/ps.c', C);
  execFileSync('gcc', ['-O1','-o','/tmp/psbin','/tmp/ps.c']);
  const hw = execFileSync('/tmp/psbin').toString().trim();
  // interpreter
  const m = new Memory([{ base: CODE, bytes: code.slice() }]);
  m.write(BUF, 8n, SEEDLO); m.write(BUF+8n, 8n, SEEDHI);
  const cpu = new CPU(m);
  for (let q=0;q<16;q++) cpu.regs[q]=0n;
  cpu.regs[4]=CODE+0x1000n; m.write(cpu.regs[4],8n,SENT); cpu.rip=CODE;
  let g=0; while(cpu.rip!==SENT){cpu.step(); if(++g>50) throw new Error('runaway');}
  const it = ((m.read(BUF+0x18n,8n) << 64n) | m.read(BUF+0x10n,8n)).toString(16).padStart(32,'0');
  // aot
  let r; try { r = compileFunctionWat(new Memory([{base:CODE,bytes:code}]), CODE, {guestBase:CODE, ramBase:0}); }
  catch (e) { console.log(`  ${op} ${c}: REFUSED ${e.message.slice(0,40)}`); continue; }
  writeFileSync('/tmp/ps.wat', r.wat);
  execFileSync('wat2wasm',['--enable-tail-call','/tmp/ps.wat','-o','/tmp/ps.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/ps.wasm'));
  const mem = new WebAssembly.Memory({initial:4096});
  const stub=()=>{throw new Error('escape')};
  const inst = new WebAssembly.Instance(mod,{js:{mem,ftab:new WebAssembly.Table({initial:0,element:'anyfunc'})},env:{syscall:stub,callout:stub,deopt:stub,loophot:stub}});
  const rv=new BigInt64Array(mem.buffer,0,16), dv=new DataView(mem.buffer);
  new Uint8Array(mem.buffer).set(code,0);
  const off = Number(BUF-CODE);
  dv.setBigUint64(off, SEEDLO, true); dv.setBigUint64(off+8, SEEDHI, true);
  for(let q=0;q<16;q++) rv[q]=0n;
  rv[4]=BigInt.asIntN(64,CODE+0x1000n); dv.setBigUint64(0x1000,SENT,true);
  inst.exports[r.entryName]();
  const ao = ((dv.getBigUint64(off+0x18,true) << 64n) | dv.getBigUint64(off+0x10,true)).toString(16).padStart(32,'0');
  n++;
  if (hw !== it || hw !== ao) { bad++;
    console.log(`  ${op.padEnd(6)} ${String(c).padStart(3)}: hw ${hw}${it!==hw?`\n${' '.repeat(13)}interp ${it}`:''}${ao!==hw?`\n${' '.repeat(13)}aot    ${ao}`:''}`); }
}
console.log(`\n${n-bad}/${n} SSE shift-by-immediate results match hardware in BOTH engines ` +
            `(${OPS.length} forms x ${COUNTS.length} counts, every count from the lane width up included)`);
if (bad) process.exit(1);

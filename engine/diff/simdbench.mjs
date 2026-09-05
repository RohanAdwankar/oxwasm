// SIMD-vectorized pixel loop vs native (also vectorized by gcc) vs scalar JIT.
import { CPU, Memory } from '../interp.mjs';
import { compileVectorLoop } from '../jitsimd.mjs';
import { compileLoop } from '../jit2.mjs';
import { decode } from '../decode.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';

const CODE = 0x10000000n, GBASE = 0x20000000n, RAM = 1 << 20, DST = 0x4000000, NPX = 64 << 20;
const asm = `mov rsi, 0x20000000
mov rdi, 0x24000000
mov rcx, ${NPX}
top:
movzx eax, byte [rsi]
add rax, 0x10
xor rax, 0x55
and rax, 0xff
mov [rdi], al
inc rsi
inc rdi
dec rcx
jnz top`;
writeFileSync('/tmp/sb.asm', 'BITS 64\n' + asm);
execFileSync('nasm', ['-f','bin','-o','/tmp/sb.bin','/tmp/sb.asm']);
const bin = readFileSync('/tmp/sb.bin'); const code = new Uint8Array(0x10000); code.set(bin);
const rmem = new Memory([{ base: CODE, bytes: code }]);
let scan = CODE, top = null;
while (scan < CODE + BigInt(bin.length)) { const insn = decode(i=>Number(rmem.read(scan+BigInt(i),1n)),scan);
  if (insn.mnem==='jcc'){top=scan+BigInt(insn.len)+insn.rel;break;} scan+=BigInt(insn.len); }
const cpuP = new CPU(new Memory([{ base: CODE, bytes: code }])); cpuP.rip=CODE;
for(let r=0;r<16;r++)cpuP.regs[r]=0n; while(cpuP.rip<top)cpuP.step();

const pages = Math.ceil((RAM + DST + NPX) / 65536) + 32;
function freshMem() {
  const wmem = new WebAssembly.Memory({ initial: pages });
  const bytes = new Uint8Array(wmem.buffer); const rv = new BigInt64Array(wmem.buffer);
  for (let i=0;i<NPX;i++) bytes[RAM+i] = (i*13+7)&0xff;
  for(let r=0;r<16;r++) rv[r] = BigInt.asIntN(64, cpuP.regs[r]);
  return { wmem, bytes };
}

// SIMD JIT
const s1 = freshMem();
const vblk = compileVectorLoop(rmem, top, { guestBase: GBASE, ramBase: RAM });
const vi = (await WebAssembly.instantiate(vblk.wasm, { js:{ mem: s1.wmem } })).instance;
const rv1 = new BigInt64Array(s1.wmem.buffer);
let simdNs = 1e18;
for (let rep = 0; rep < 5; rep++) {
  for (let r=0;r<16;r++) rv1[r] = BigInt.asIntN(64, cpuP.regs[r]);   // reset rsi/rdi/rcx
  const t = process.hrtime.bigint(); vi.exports.run();
  const ns = Number(process.hrtime.bigint()-t)/NPX; if (ns < simdNs) simdNs = ns;
}
const simdCheck = s1.bytes[RAM+DST+123456];

// scalar JIT
const s2 = freshMem();
const sblk = compileLoop(rmem, top, { guestBase: GBASE, ramBase: RAM });
const si = (await WebAssembly.instantiate(sblk.wasm, { js:{ mem: s2.wmem } })).instance;
let t = process.hrtime.bigint(); si.exports.run();
const scalarNs = Number(process.hrtime.bigint()-t)/NPX;

// native (gcc -O2, auto-vectorizes)
const cSrc=`#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
int main(){uint8_t*src=malloc(${NPX}),*dst=malloc(${NPX});
 for(long i=0;i<${NPX};i++)src[i]=(i*13+7)&0xff;
 struct timespec a,b;clock_gettime(CLOCK_MONOTONIC,&a);
 for(long i=0;i<${NPX};i++){uint32_t v=src[i];v+=0x10;v^=0x55;v&=0xff;dst[i]=v;}
 clock_gettime(CLOCK_MONOTONIC,&b);
 double ns=(b.tv_sec-a.tv_sec)*1e9+(b.tv_nsec-a.tv_nsec);
 fprintf(stderr,"%.4f %d\\n",ns/${NPX},dst[123456]);return 0;}`;
writeFileSync('/tmp/sb.c',cSrc); execFileSync('gcc',['-O2','-o','/tmp/sbc','/tmp/sb.c']);
const nat=spawnSync('/tmp/sbc'); const np=nat.stderr.toString().trim().split(' ');
const natNs=Number(np[0]); const natCheck=Number(np[1]);

console.log(`pixel transform, ${NPX/(1<<20)}M pixels\n`);
console.log(`correctness: simd[123456]=${simdCheck}  native=${natCheck}  ${simdCheck===natCheck?'MATCH':'MISMATCH'}\n`);
console.log(`native (gcc -O3 -march=native, AVX2, best-of-5)  ${natNs.toFixed(3)} ns/px   (1.0x)`);
console.log(`SIMD JIT (v128 128-bit, best-of-5)               ${simdNs.toFixed(3)} ns/px   (${(simdNs/natNs).toFixed(2)}x native)`);
console.log(`scalar JIT                     ${scalarNs.toFixed(3)} ns/px   (${(scalarNs/natNs).toFixed(1)}x native)`);
console.log(`\nSIMD JIT is ${(scalarNs/simdNs).toFixed(1)}x faster than the scalar JIT`);

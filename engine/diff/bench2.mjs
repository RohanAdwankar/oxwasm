// Superblock loop JIT vs native vs interpreter, on a real hot loop.
// The loop runs entirely inside one wasm function (regs in locals), so the
// JS<->WASM boundary is crossed once, not once per iteration.
import { CPU, Memory } from '../interp.mjs';
import { compileLoop } from '../jit2.mjs';
import { decode } from '../decode.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';

const N = 50_000_000;
const ASM = `mov rax, 0
mov rdx, 0x9e3779b9
mov rcx, ${N}
top:
add rax, rcx
xor rax, rdx
add rax, rcx
and rax, 0x3fffffff
sub rcx, 1
jnz top`;
const CODE = 0x10000000n;
writeFileSync('/tmp/b2.asm', 'BITS 64\n' + ASM);
execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/b2.bin', '/tmp/b2.asm']);
const bin = readFileSync('/tmp/b2.bin'); const code = new Uint8Array(0x10000); code.set(bin);

// locate loop top
const m = new Memory([{ base: CODE, bytes: code }]);
let scan = CODE, loopTop = null;
while (scan < CODE + BigInt(bin.length)) {
  const insn = decode((i)=>Number(m.read(scan+BigInt(i),1n)), scan);
  if (insn.mnem === 'jcc') { loopTop = scan + BigInt(insn.len) + insn.rel; break; }
  scan += BigInt(insn.len);
}

// --- interp (smaller N; it's ~10000x, would take too long at full N) ---
const IN = 500_000;
{
  const asmSmall = ASM.replace(`${N}`, `${IN}`);
  writeFileSync('/tmp/b2s.asm', 'BITS 64\n' + asmSmall);
  execFileSync('nasm', ['-f','bin','-o','/tmp/b2s.bin','/tmp/b2s.asm']);
  const b = readFileSync('/tmp/b2s.bin'); const c = new Uint8Array(0x10000); c.set(b);
  const cpu = new CPU(new Memory([{ base: CODE, bytes: c }])); cpu.rip = CODE;
  for (let r=0;r<16;r++) cpu.regs[r]=0n;
  const t = process.hrtime.bigint();
  while (cpu.rip >= CODE && cpu.rip < CODE + BigInt(b.length)) cpu.step();
  var interpNsPerIter = Number(process.hrtime.bigint() - t) / IN;
}

// --- superblock JIT (full N) ---
const cpuP = new CPU(new Memory([{ base: CODE, bytes: code }])); cpuP.rip = CODE;
for (let r=0;r<16;r++) cpuP.regs[r]=0n;
while (cpuP.rip < loopTop) cpuP.step();
const blk = compileLoop(m, loopTop);
const wmem = new WebAssembly.Memory({ initial: 256 });
const view = new BigInt64Array(wmem.buffer);
for (let r=0;r<16;r++) view[r] = BigInt.asIntN(64, cpuP.regs[r]);
const { instance } = await WebAssembly.instantiate(blk.wasm, { js: { mem: wmem } });
let t = process.hrtime.bigint();
instance.exports.run();
const jitNsPerIter = Number(process.hrtime.bigint() - t) / N;
const jitRax = BigInt.asUintN(64, view[0]);

// --- native ---
const cSrc = `#include <stdint.h>
#include <stdio.h>
#include <time.h>
int main(){
  uint64_t rax=0, rdx=0x9e3779b9, rcx=${N}; struct timespec a,b;
  clock_gettime(CLOCK_MONOTONIC,&a);
  do { rax+=rcx; rax^=rdx; rax+=rcx; rax&=0x3fffffff; rcx-=1; } while(rcx);
  clock_gettime(CLOCK_MONOTONIC,&b);
  double ns=(b.tv_sec-a.tv_sec)*1e9+(b.tv_nsec-a.tv_nsec);
  fprintf(stderr,"%.3f %llu\\n", ns/${N}, (unsigned long long)rax);
  return 0;
}`;
writeFileSync('/tmp/b2.c', cSrc);
execFileSync('gcc', ['-O2', '-o', '/tmp/b2c', '/tmp/b2.c']);
const nat = spawnSync('/tmp/b2c');
const natParts = nat.stderr.toString().trim().split(' ');
const natNsPerIter = Number(natParts[0]); const natRax = BigInt(natParts[1]);

console.log(`hot loop, ${N.toLocaleString()} iterations (5 ops/iter)\n`);
console.log(`correctness: jit rax=${jitRax.toString(16)}  native rax=${natRax.toString(16)}  ${jitRax===natRax?'MATCH':'MISMATCH'}\n`);
console.log(`native            ${natNsPerIter.toFixed(3)} ns/iter   (1.0x)`);
console.log(`superblock JIT    ${jitNsPerIter.toFixed(3)} ns/iter   (${(jitNsPerIter/natNsPerIter).toFixed(1)}x native)`);
console.log(`interpreter       ${interpNsPerIter.toFixed(1)} ns/iter   (${(interpNsPerIter/natNsPerIter).toFixed(0)}x native)`);
console.log(`\nsuperblock JIT is ${(interpNsPerIter/jitNsPerIter).toFixed(0)}x faster than the interpreter`);

// Benchmark: how close is the tier-1 JIT to native, vs the interpreter?
// Same straight-line integer block, executed N times three ways:
//   native   — the equivalent C, gcc -O2 (the 1x reference)
//   jit      — compiled once to wasm, wasm fn called N times
//   interp   — tier-0 BigInt interpreter, stepped N times
import { CPU, Memory } from '../interp.mjs';
import { compileBlock } from '../jit.mjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';

// a heavy-ish register block (no memory/branches yet): mixes the ALU ops
const ASM = `
add rax, rbx
xor rbx, rax
add rax, rbx
and rax, 0xffffff
add rbx, rax
xor rax, rbx
add rax, 0x11
add rbx, rax
xor rbx, rax
add rax, rbx
and rbx, 0xffff
add rax, rbx
xor rax, rbx
add rax, rbx
`;
const N = 5_000_000;

// assemble
writeFileSync('/tmp/bench.asm', 'BITS 64\n' + ASM);
execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/bench.bin', '/tmp/bench.asm']);
const bin = readFileSync('/tmp/bench.bin');
const code = new Uint8Array(0x10000); code.set(bin);
const CODE = 0x10000000n;

// --- interp ---
const cpu = new CPU(new Memory([{ base: CODE, bytes: code }]));
let t = process.hrtime.bigint();
for (let k = 0; k < N; k++) {
  cpu.rip = CODE;
  cpu.regs[0] = BigInt(k); cpu.regs[3] = BigInt(k * 3 + 1);   // rax, rbx
  while (cpu.rip >= CODE && cpu.rip < CODE + BigInt(bin.length)) cpu.step();
}
const interpNs = Number(process.hrtime.bigint() - t);

// --- jit ---
const blk = compileBlock(new Memory([{ base: CODE, bytes: code }]), CODE);
const wmem = new WebAssembly.Memory({ initial: 1 });
const view = new BigInt64Array(wmem.buffer);
const { instance } = await WebAssembly.instantiate(blk.wasm, { js: { mem: wmem } });
const run = instance.exports.run;
t = process.hrtime.bigint();
let acc = 0n;
for (let k = 0; k < N; k++) { view[0] = BigInt(k); view[3] = BigInt(k*3+1); run(); acc ^= view[0]; }
const jitNs = Number(process.hrtime.bigint() - t);
const jitResult = BigInt.asUintN(64, view[0]);

// --- native ---
const cSrc = `#include <stdint.h>
#include <stdio.h>
#include <time.h>
int main(){
  volatile uint64_t sink=0; struct timespec a,b; clock_gettime(CLOCK_MONOTONIC,&a);
  for(long k=0;k<${N};k++){
    uint64_t rax=k, rbx=(uint64_t)k*3+1;
    rax+=rbx; rbx^=rax; rax+=rbx; rax&=0xffffff; rbx+=rax; rax^=rbx; rax+=0x11;
    rbx+=rax; rbx^=rax; rax+=rbx; rbx&=0xffff; rax+=rbx; rax^=rbx; rax+=rbx;
    sink=rax;                       /* volatile store: loop body cannot be elided */
  }
  clock_gettime(CLOCK_MONOTONIC,&b);
  double ns=(b.tv_sec-a.tv_sec)*1e9+(b.tv_nsec-a.tv_nsec);
  fprintf(stderr,"%.0f %llu\\n", ns, (unsigned long long)sink);
  return 0;
}`;
writeFileSync('/tmp/bench.c', cSrc);
execFileSync('gcc', ['-O2', '-o', '/tmp/benchc', '/tmp/bench.c']);
const { spawnSync } = await import('node:child_process');
const nat = spawnSync('/tmp/benchc');
const nn = Number(nat.stderr.toString().trim().split(' ')[0]);

const perOp = (ns) => (ns / N).toFixed(1);
console.log(`block executed ${N.toLocaleString()}x (16 ALU ops each)\n`);
console.log(`native   ${perOp(nn)} ns/run   (1.0x)`);
console.log(`jit      ${perOp(jitNs)} ns/run   (${(jitNs/nn).toFixed(1)}x native)`);
console.log(`interp   ${perOp(interpNs)} ns/run   (${(interpNs/nn).toFixed(0)}x native)`);
console.log(`\njit is ${(interpNs/jitNs).toFixed(0)}x faster than the interpreter`);

// Pixel-loop: JIT vs native vs interpreter. dst[i] = (src[i]+0x10)^0x55.
import { CPU, Memory } from '../interp.mjs';
import { compileLoop } from '../jit2.mjs';
import { decode } from '../decode.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';

const CODE = 0x10000000n, GBASE = 0x20000000n, RAM = 1 << 20;   // guest RAM at 1MB in wasm
const NPX = 8 << 20;                                            // 8M pixels
const asm = `mov rsi, 0x20000000
mov rdi, 0x22000000
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
writeFileSync('/tmp/pb.asm', 'BITS 64\n' + asm);
execFileSync('nasm', ['-f','bin','-o','/tmp/pb.bin','/tmp/pb.asm']);
const bin = readFileSync('/tmp/pb.bin'); const code = new Uint8Array(0x10000); code.set(bin);

// locate loop + entry regs
const rmem = new Memory([{ base: CODE, bytes: code }]);
let scan = CODE, loopTop = null;
while (scan < CODE + BigInt(bin.length)) { const insn = decode(i=>Number(rmem.read(scan+BigInt(i),1n)),scan);
  if (insn.mnem==='jcc'){loopTop=scan+BigInt(insn.len)+insn.rel;break;} scan+=BigInt(insn.len); }
const cpuP = new CPU(new Memory([{ base: CODE, bytes: code }])); cpuP.rip=CODE;
for(let r=0;r<16;r++)cpuP.regs[r]=0n; while(cpuP.rip<loopTop)cpuP.step();

// wasm layout: src at RAM (dst = src region + 0x2000000 guest = RAM + 0x2000000 wasm)
const dstGuestOff = 0x2000000;
const need = RAM + dstGuestOff + NPX;
const pages = Math.ceil(need / 65536) + 16;
const wmem = new WebAssembly.Memory({ initial: pages });
const bytes = new Uint8Array(wmem.buffer); const regview = new BigInt64Array(wmem.buffer);
for (let i=0;i<NPX;i++) bytes[RAM + i] = (i*7+3)&0xff;
for(let r=0;r<16;r++) regview[r]=BigInt.asIntN(64,cpuP.regs[r]);
const blk = compileLoop(rmem, loopTop, { guestBase: GBASE, ramBase: RAM });
const { instance } = await WebAssembly.instantiate(blk.wasm, { js:{ mem: wmem } });
let t = process.hrtime.bigint(); instance.exports.run();
const jitNs = Number(process.hrtime.bigint()-t)/NPX;
const jitCheck = bytes[RAM + dstGuestOff + 12345];

// interpreter on a small slice (it's ~7000x)
const IN = 200_000;
{ const a2 = asm.replace(`${NPX}`, `${IN}`); writeFileSync('/tmp/pbs.asm','BITS 64\n'+a2);
  execFileSync('nasm',['-f','bin','-o','/tmp/pbs.bin','/tmp/pbs.asm']);
  const b=readFileSync('/tmp/pbs.bin'); const c=new Uint8Array(0x10000); c.set(b);
  const g=new Uint8Array(0x4000000); for(let i=0;i<IN;i++)g[i]=(i*7+3)&0xff;
  const cpu=new CPU(new Memory([{base:CODE,bytes:c},{base:GBASE,bytes:g}])); cpu.rip=CODE;
  for(let r=0;r<16;r++)cpu.regs[r]=0n;
  const tt=process.hrtime.bigint(); while(cpu.rip>=CODE&&cpu.rip<CODE+BigInt(b.length))cpu.step();
  var interpNs=Number(process.hrtime.bigint()-tt)/IN; }

// native
const cSrc=`#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
int main(){uint8_t*src=malloc(${NPX}),*dst=malloc(${NPX});
 for(long i=0;i<${NPX};i++)src[i]=(i*7+3)&0xff;
 struct timespec a,b;clock_gettime(CLOCK_MONOTONIC,&a);
 for(long i=0;i<${NPX};i++){uint32_t v=src[i];v+=0x10;v^=0x55;v&=0xff;dst[i]=v;}
 clock_gettime(CLOCK_MONOTONIC,&b);
 double ns=(b.tv_sec-a.tv_sec)*1e9+(b.tv_nsec-a.tv_nsec);
 fprintf(stderr,"%.4f %d\\n",ns/${NPX},dst[12345]);return 0;}`;
writeFileSync('/tmp/pb.c',cSrc); execFileSync('gcc',['-O2','-o','/tmp/pbc','/tmp/pb.c']);
const nat=spawnSync('/tmp/pbc'); const np=nat.stderr.toString().trim().split(' ');
const natNs=Number(np[0]); const natCheck=Number(np[1]);

console.log(`pixel transform, ${(NPX/1e6)}M pixels (8 ops/px)\n`);
console.log(`correctness: jit[12345]=${jitCheck}  native[12345]=${natCheck}  ${jitCheck===natCheck?'MATCH':'MISMATCH'}\n`);
console.log(`native          ${natNs.toFixed(3)} ns/px   (1.0x)`);
console.log(`superblock JIT  ${jitNs.toFixed(3)} ns/px   (${(jitNs/natNs).toFixed(1)}x native)`);
console.log(`interpreter     ${interpNs.toFixed(1)} ns/px   (${(interpNs/natNs).toFixed(0)}x native)`);
console.log(`\nJIT is ${(interpNs/jitNs).toFixed(0)}x faster than the interpreter`);

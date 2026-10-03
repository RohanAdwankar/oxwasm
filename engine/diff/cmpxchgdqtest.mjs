// Differential: cmpxchg8b / cmpxchg16b against hardware, equal and unequal
// compares, with and without a LOCK prefix. Registers, memory and ZF.
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, BUF = 0x420000n, SENT = 0xdeadbee0n;
const M64 = (1n << 64n) - 1n;
const cases = [];
for (const wide of [false, true]) for (const lock of [false, true]) for (const eq of [true, false]) cases.push({ wide, lock, eq });

let bad = 0;
for (const { wide, lock, eq } of cases) {
  const mnem = wide ? 'cmpxchg16b' : 'cmpxchg8b';
  const mask = wide ? M64 : 0xFFFFFFFFn;
  const mem = [0x1122334455667788n & mask, 0x99aabbccddeeff00n & mask];
  const rax = eq ? mem[0] : (mem[0] ^ 1n) & mask, rdx = mem[1];
  const rbx = 0x0123456789abcdefn & mask, rcx = 0xfedcba9876543210n & mask;
  const body = `${lock ? 'lock ' : ''}${mnem} [0x420000]\nret`;
  writeFileSync('/tmp/cx.asm', 'BITS 64\n' + body);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/cx.bin', '/tmp/cx.asm']);
  const code = new Uint8Array(0x30000); code.set(readFileSync('/tmp/cx.bin'));

  const C = `#include <stdio.h>
    int main(){ unsigned long long m[2] __attribute__((aligned(16))) = {0x${mem[0].toString(16)}ULL, 0x${mem[1].toString(16)}ULL};
      unsigned long long a=0x${rax.toString(16)}ULL, d=0x${rdx.toString(16)}ULL, b=0x${rbx.toString(16)}ULL, c=0x${rcx.toString(16)}ULL; unsigned char z;
      ${wide ? `asm volatile("${lock ? 'lock ' : ''}cmpxchg16b %1; setz %2":"+a"(a),"+m"(m),"=q"(z),"+d"(d):"b"(b),"c"(c):"cc");`
             : `{ unsigned int a32=a,d32=d; unsigned int*mm=(unsigned int*)m; asm volatile("${lock ? 'lock ' : ''}cmpxchg8b %1; setz %2":"+a"(a32),"+m"(*(unsigned long long*)m),"=q"(z),"+d"(d32):"b"((unsigned)b),"c"((unsigned)c):"cc"); a=a32; d=d32; }`}
      printf("%llx %llx %llx %llx %d\\n", a, d, m[0], m[1], z); return 0; }`;
  writeFileSync('/tmp/cx.c', C);
  execFileSync('gcc', ['-O1', '-o', '/tmp/cxbin', '/tmp/cx.c']);
  const hw = execFileSync('/tmp/cxbin').toString().trim();

  const m = new Memory([{ base: CODE, bytes: code.slice() }]);
  m.write(BUF, 8n, mem[0]); m.write(BUF + 8n, 8n, mem[1]);
  const cpu = new CPU(m);
  for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
  cpu.regs[0] = rax; cpu.regs[2] = rdx; cpu.regs[3] = rbx; cpu.regs[1] = rcx;
  cpu.regs[4] = CODE + 0x1000n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
  let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 20) throw new Error('runaway'); }
  const hex = (v) => v.toString(16);
  const mine = [hex(cpu.regs[0] & (wide ? M64 : 0xFFFFFFFFn)), hex(cpu.regs[2] & (wide ? M64 : 0xFFFFFFFFn)),
                hex(m.read(BUF, 8n)), hex(m.read(BUF + 8n, 8n)), cpu.f.zf].join(' ');
  if (hw !== mine) { bad++; console.log(`  ${lock ? 'lock ' : ''}${mnem} eq=${eq}\n    hw   ${hw}\n    mine ${mine}`); }
}
console.log(`\n${cases.length - bad}/${cases.length} cmpxchg8b/16b results match hardware`);
process.exit(bad ? 1 : 0);

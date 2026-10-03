// Differential: pclmulqdq against hardware, all four qword selections, with
// operands that exercise carries across the 64-bit boundary.
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, BUF = 0x420000n, SENT = 0xdeadbee0n, M64 = (1n << 64n) - 1n;
const vals = [0n, 1n, 0x8000000000000000n, 0xffffffffffffffffn, 0x0123456789abcdefn, 0xfedcba9876543210n, 0x00000000ffffffffn, 0xaaaaaaaaaaaaaaaan];
let bad = 0, n = 0;
for (const imm of [0x00, 0x01, 0x10, 0x11]) {
  writeFileSync('/tmp/pc.asm', `BITS 64\nmovdqu xmm0, [0x420000]\nmovdqu xmm1, [0x420010]\npclmulqdq xmm0, xmm1, ${imm}\nmovdqu [0x420100], xmm0\nret`);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/pc.bin', '/tmp/pc.asm']);
  const code = new Uint8Array(0x30000); code.set(readFileSync('/tmp/pc.bin'));
  for (let i = 0; i < vals.length; i++) for (let j = 0; j < vals.length; j += 3) {
    const a0 = vals[i], a1 = vals[(i + 3) % vals.length], b0 = vals[j], b1 = vals[(j + 5) % vals.length];
    const C = `int main(){unsigned long long q[4] __attribute__((aligned(16)))={0x${a0.toString(16)}ULL,0x${a1.toString(16)}ULL,0x${b0.toString(16)}ULL,0x${b1.toString(16)}ULL}; unsigned long long o[2] __attribute__((aligned(16)));
      asm volatile("movdqu %1,%%xmm0\\n\\tmovdqu %2,%%xmm1\\n\\tpclmulqdq $${imm},%%xmm1,%%xmm0\\n\\tmovdqu %%xmm0,%0":"=m"(o):"m"(q[0]),"m"(q[2]):"xmm0","xmm1");
      __builtin_printf("%016llx%016llx\\n", o[1], o[0]); return 0;}`;
    writeFileSync('/tmp/pc.c', C);
    execFileSync('gcc', ['-O1', '-msse4.2', '-mpclmul', '-o', '/tmp/pcbin', '/tmp/pc.c']);
    const hw = execFileSync('/tmp/pcbin').toString().trim();
    const m = new Memory([{ base: CODE, bytes: code.slice() }]);
    m.write(BUF, 8n, a0); m.write(BUF + 8n, 8n, a1); m.write(BUF + 16n, 8n, b0); m.write(BUF + 24n, 8n, b1);
    const cpu = new CPU(m);
    for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
    cpu.regs[4] = CODE + 0x1000n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
    let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 20) throw new Error('runaway'); }
    const mine = (m.read(BUF + 0x108n, 8n)).toString(16).padStart(16, '0') + (m.read(BUF + 0x100n, 8n)).toString(16).padStart(16, '0');
    n++; if (hw !== mine) { bad++; console.log(`  imm=${imm} ${a0.toString(16)},${a1.toString(16)} x ${b0.toString(16)},${b1.toString(16)}\n    hw   ${hw}\n    mine ${mine}`); }
  }
}
console.log(`\n${n - bad}/${n} pclmulqdq results match hardware`);
process.exit(bad ? 1 : 0);

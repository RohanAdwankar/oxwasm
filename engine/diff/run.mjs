// Differential test: tier-0 interpreter vs the real CPU (via ./stepper).
// Every architectural step must match: rip, all 16 GPRs, and the flag
// bits the instruction stream defines (undefined-flag cases mask out).
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { CPU, Memory } from '../interp.mjs';

const CODE = 0x10000000n, SCRATCH = 0x20000000n, STACK = 0x30000000n, RSP0 = 0x30008000n;
const FULL = 0x8C5n;               // CF|PF|ZF|SF|OF

export function runCase(name, asm, { flagMask = FULL, maxSteps = 500 } = {}) {
  writeFileSync('/tmp/case.asm', 'BITS 64\n' + asm + '\n');
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/case.bin', '/tmp/case.asm']);
  const hw = execFileSync('./stepper', ['/tmp/case.bin', String(maxSteps)])
    .toString().trim().split('\n').map(l => l.split(' ').map(x => BigInt('0x' + x)));

  const code = new Uint8Array(0x10000);
  code.set(new Uint8Array(readFileSync('/tmp/case.bin')));
  const scratch = new Uint8Array(0x10000);
  for (let i = 0; i < 0x10000; i++) scratch[i] = Number((SCRATCH + BigInt(i)) ^ ((SCRATCH + BigInt(i)) >> 8n)) & 0xFF;
  const cpu = new CPU(new Memory([
    { base: CODE, bytes: code }, { base: SCRATCH, bytes: scratch },
    { base: STACK, bytes: new Uint8Array(0x10000) },
  ]));
  cpu.rip = CODE;
  // stepper assigns by NAME: rax+0 rbx+1 rcx+2 rdx+3 rsi+4 rdi+5 r8+8...
  const INIT = { 0: 0n, 3: 1n, 1: 2n, 2: 3n, 6: 4n, 7: 5n };
  for (let r = 0; r < 16; r++)
    cpu.regs[r] = 0x0101010101010100n + (r >= 8 ? BigInt(r) : INIT[r] ?? 0n);
  cpu.regs[4] = RSP0; cpu.regs[5] = RSP0;

  const NAMES = ['rip','rax','rbx','rcx','rdx','rsi','rdi','rbp','rsp','r8','r9','r10','r11','r12','r13','r14','r15','flags'];
  const REGIDX = [0, 3, 1, 2, 6, 7, 5, 4, 8, 9, 10, 11, 12, 13, 14, 15]; // stepper order rax,rbx,rcx,rdx,rsi,rdi,rbp,rsp -> interp indices
  for (let s = 1; s < hw.length; s++) {
    let insn;
    try { insn = cpu.step(); } catch (e) {
      return { name, ok: false, step: s, err: e.message };
    }
    const line = hw[s];
    const mine = [cpu.rip, ...REGIDX.map(i => cpu.regs[i]), cpu.flagsValue()];
    for (let k = 0; k < 18; k++) {
      let a = line[k], b = mine[k];
      if (k === 17) { a &= flagMask; b &= flagMask; }
      if (a !== b) return { name, ok: false, step: s, field: NAMES[k],
        hw: a.toString(16), interp: b.toString(16), insn: insn && insn.mnem };
    }
  }
  return { name, ok: true, steps: hw.length - 1 };
}

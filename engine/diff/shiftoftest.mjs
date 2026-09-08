// Differential against HARDWARE: OF after a shift, for every count.
//
// Every other flag test in here compares the AOT against the interpreter. That
// cannot catch the interpreter being wrong, and it was: OF is documented
// "undefined" for any shift count but 1, which this engine read as "unchanged"
// and left the previous instruction's OF in place. A CPU computes it.
//
// So this one asks the CPU. Each case runs natively - the shift, then `jo` to
// a distinguishable exit status - and the same instructions through the
// interpreter, and the two must agree. The incoming OF is set both ways per
// case, because "unchanged" and "computed" are only distinguishable when the
// incoming value differs from the computed one.
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';

// Widths matter: the first version of this only ever shifted rax, and the AOT
// side agreed with the interpreter at every width, so a narrow-width error in
// the ORACLE would have been invisible to every other test in this directory.
const REGS = { rax: 64, eax: 32, ax: 16, al: 8 };
const OPS = ['shl', 'shr', 'sar'];
const COUNTS = [1, 2, 3, 5, 17, 31];
const VALS = ['0x8000000000000000', '0x4000000000000000', '0xC000000000000000',
              '0x2000000000000000', '0x6000000000000000', '0x1',
              '0xFFFFFFFFFFFFFFFF', '0x0000000100000000'];
const PRE = { 0: '  xor rax, rax\n', 1: '  mov rax, 0x7FFFFFFFFFFFFFFF\n  add rax, 1\n' };
// the operand loaded into the register under test, masked to its width
const load = (reg, val) => reg === 'rax' ? `  mov rax, ${val}\n`
  : `  mov rax, ${val}\n  mov ${reg}, ${reg === 'eax' ? 'eax' : reg === 'ax' ? 'ax' : 'al'}\n`;

// native: exit status is OF
const nativeOF = (op, n, val, inOf, reg = 'rax') => {
  const src = `BITS 64\nglobal _start\nsection .text\n_start:\n${PRE[inOf]}` +
    `${load(reg, val)}  ${op} ${reg}, ${n}\n  jo t\n  mov rdi, 0\n  jmp o\nt:\n  mov rdi, 1\no:\n  mov rax, 60\n  syscall\n`;
  writeFileSync('/tmp/sof.asm', src);
  execFileSync('nasm', ['-f', 'elf64', '-o', '/tmp/sof.o', '/tmp/sof.asm']);
  execFileSync('ld', ['-o', '/tmp/sof', '/tmp/sof.o']);
  try { execFileSync('/tmp/sof'); return 0; } catch (e) { return e.status; }
};

// interpreter: same instruction stream, read cpu.f.of
const CODE = 0x400000n, SENT = 0xdeadbee0n;
const interpOF = (op, n, val, inOf, reg = 'rax') => {
  const src = `BITS 64\n${PRE[inOf]}${load(reg, val)}  ${op} ${reg}, ${n}\n  ret\n`;
  writeFileSync('/tmp/sof2.asm', src);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/sof2.bin', '/tmp/sof2.asm']);
  const b = execFileSync('cat', ['/tmp/sof2.bin'], { encoding: 'buffer' });
  const c = new Uint8Array(0x1000); c.set(b);
  const m = new Memory([{ base: CODE, bytes: c }]);
  const cpu = new CPU(m);
  for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
  cpu.regs[4] = CODE + 0x700n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
  let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 200) throw new Error('runaway'); }
  return cpu.f.of ? 1 : 0;
};

let pass = 0, fail = 0;
for (const [reg, W] of Object.entries(REGS))
for (const op of OPS) for (const n of COUNTS) for (const val of VALS) for (const inOf of [0, 1]) {
  if (n >= W) continue;                       // a count at or past the width is a different question
  const hw = nativeOF(op, n, val, inOf, reg), sw = interpOF(op, n, val, inOf, reg);
  if (hw === sw) pass++;
  else { fail++; if (fail <= 10) console.log(`  MISMATCH ${reg} ${op} ${val} by ${n}, incoming OF=${inOf}: hardware=${hw} interpreter=${sw}`); }
}
for (const f of ['/tmp/sof.asm', '/tmp/sof.o', '/tmp/sof', '/tmp/sof2.asm', '/tmp/sof2.bin'])
  try { unlinkSync(f); } catch {}
console.log(`\n${pass}/${pass + fail} shift OF results match hardware (interpreter vs this CPU)`);
if (fail) process.exit(1);

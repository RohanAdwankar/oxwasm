// Differential test on REAL gcc output: call compiled functions with
// controlled arguments; every hardware step must match tier-0.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { runCase } from './run.mjs';

// The blobs are built here, from realsrc/, every run. They used to be
// whatever a developer had left in /tmp, so the whole suite died on a fresh
// machine at `incbin: unable to get length of file /tmp/fib-O1.bin` - after
// the 316 hardware cases had already passed, which made it read like a
// hardware failure rather than a missing file. Each source is one function
// with no relocations in .text, so its .text section IS the callable blob:
// -fno-pic keeps it free of GOT references and -fno-builtin stops gcc
// turning strlen_ back into a call to libc's. Whatever this gcc emits is a
// valid case - the test compares it against the hardware, not against a
// recorded instruction sequence.
const SRC = new URL('./realsrc/', import.meta.url).pathname;
for (const f of ['fib', 'mix', 'strlen_']) for (const O of ['O1', 'O2']) {
  const o = `/tmp/rc_${f}-${O}.o`;
  try {
    execFileSync('gcc', [`-${O}`, '-fno-builtin', '-fcf-protection=none', '-fno-pic',
                         '-c', `${SRC}${f}.c`, '-o', o]);
    execFileSync('objcopy', ['-O', 'binary', '--only-section=.text', o, `/tmp/${f}-${O}.bin`]);
  } catch (e) {
    if (!existsSync(`/tmp/${f}-${O}.bin`)) { console.log(`FAIL cannot build ${f}-${O}: ${e.message}`); process.exit(1); }
  }
}

const calls = [
  ['gcc-fib-O1', 'mov rdi, 30', 'fib-O1'],
  ['gcc-fib-O2', 'mov rdi, 30', 'fib-O2'],
  ['gcc-mix-O1', 'mov rdi, 0x123456789\nmov rsi, -42', 'mix-O1', 0x0C5n],
  ['gcc-mix-O2', 'mov rdi, 0x123456789\nmov rsi, -42', 'mix-O2', 0x0C5n],
  // build a string in scratch, then strlen it
  ['gcc-strlen-O1', `mov rdi, 0x20000800
mov byte [rdi+37], 0
`, 'strlen_-O1'],
  ['gcc-strlen-O2', `mov rdi, 0x20000800
mov byte [rdi+37], 0
`, 'strlen_-O2'],
];

let pass = 0, fail = 0, steps = 0;
for (const [name, pre, bin, mask] of calls) {
  const asm = `${pre}
call func
mov r15, rax        ; make the result visible in the trace
ret
func: incbin "/tmp/${bin}.bin"`;
  const r = runCase(name, asm, { maxSteps: 2000, flagMask: mask ?? 0x8C5n });
  if (r.ok) { pass++; steps += r.steps; console.log('ok  ', name, r.steps, 'steps'); }
  else { fail++; console.log('FAIL', JSON.stringify(r)); }
}
console.log(`\n${pass}/${pass + fail} real-code cases, ${steps} hardware-verified instructions`);

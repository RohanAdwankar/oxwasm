// Differential test on REAL gcc output: call compiled functions with
// controlled arguments; every hardware step must match tier-0.
import { runCase } from './run.mjs';

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

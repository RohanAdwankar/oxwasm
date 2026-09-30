// Differential: loop / loope / loopne / jrcxz (opcodes E0-E3) against hardware.
// GnuTLS's assembly uses jrcxz; the decoder had none of the four.
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const CODE = 0x400000n, SENT = 0xdeadbee0n;
const BODIES = {
  loop: (n) => `mov rcx, ${n}\nxor eax, eax\nL: inc eax\nloop L\nmov rbx, rcx\nret`,
  loope: (n) => `mov rcx, ${n}\nxor eax, eax\nL: inc eax\ncmp eax, 3\nloope L\nmov rbx, rcx\nret`,
  loopne: (n) => `mov rcx, ${n}\nxor eax, eax\nL: inc eax\ncmp eax, 3\nloopne L\nmov rbx, rcx\nret`,
  jrcxz: (n) => `mov rcx, ${n}\nxor eax, eax\njrcxz Z\nmov eax, 7\nZ: mov rbx, rcx\nret`,
  jecxz: (n) => `mov rcx, ${n}\nxor eax, eax\nxor edx, edx\na32 jrcxz Z\nmov eax, 7\nZ: mov rbx, rcx\nret`,
};
let bad = 0, n = 0;
for (const [name, mk] of Object.entries(BODIES)) for (const cnt of (name.startsWith('j') ? [0, 1, '0x100000000', '0x100000001'] : name === 'loop' ? [1, 2, 3, 4, 10] : [0, 1, 2, 3, 4, 10])) {
  const body = mk(cnt); if (process.env.LX_V) console.log(name, cnt);
  const hwAsm = body.replace(/\bL\b/g, '1').replace(/\bZ\b/g, '2').replace('loop 1', 'loop 1b').replace('loope 1', 'loope 1b').replace('loopne 1', 'loopne 1b').replace(/jrcxz 2/, 'jrcxz 2f').replace('ret', '');
  const C = `int main(){unsigned long a,b; asm volatile(".intel_syntax noprefix\\n\\t${hwAsm.replace(/\n/g, '\\n\\t').replace('a32 jrcxz', 'jecxz')}\\n\\tmov %0, rax\\n\\tmov %1, rbx\\n\\t.att_syntax":"=r"(a),"=r"(b)::"rax","rbx","rcx","rdx","cc");
    __builtin_printf("%lx %lx\\n", a, b); return 0; }`;
  writeFileSync('/tmp/lx.c', C);
  try { execFileSync('gcc', ['-O0', '-o', '/tmp/lxbin', '/tmp/lx.c'], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { console.log('gcc failed', name, String(e.stderr).slice(0, 200)); bad++; continue; }
  const hw = execFileSync('/tmp/lxbin', [], { timeout: 5000 }).toString().trim();
  writeFileSync('/tmp/lx.asm', 'BITS 64\n' + body.replace('a32 jrcxz', 'jecxz'));
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/lx.bin', '/tmp/lx.asm']);
  const code = new Uint8Array(0x2000); code.set(readFileSync('/tmp/lx.bin'));
  const m = new Memory([{ base: CODE, bytes: code }]); const cpu = new CPU(m);
  for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
  cpu.regs[4] = CODE + 0x1000n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
  let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 50) throw new Error('runaway ' + name); }
  const got = `${cpu.regs[0].toString(16)} ${cpu.regs[3].toString(16)}`;
  n++; if (got !== hw) { bad++; console.log(`  ${name} rcx=${cnt}: hw ${hw}  interp ${got}`); }
}
console.log(`${n - bad}/${n} loop/jrcxz cases match hardware`);
if (bad) process.exit(1);

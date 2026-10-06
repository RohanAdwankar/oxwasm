// The interpreter's decode cache against code patched in place. A JIT (JSC
// with its JIT on, under Bun) rewrites call targets, inline caches and lazy
// slow-path stubs inside pages it mapped executable at runtime; the cache,
// keyed by address alone, kept executing the instruction it decoded first
// (the FTL's lazy slow-path stub was entered with an index it had already
// retired, and RELEASE_ASSERTed). Instructions decoded from a page the
// engine marked as runtime-executable (Memory.jit) carry their bytes and
// are re-decoded when memory differs.
import { CPU, Memory } from '../interp.mjs';

const CODE = 0x400000n, SENT = 0xdeadbee0n;
let pass = 0, fail = 0;
const is = (name, got, want) => { if (got === want) pass++; else { fail++; console.log(`FAIL ${name}: got ${got}, want ${want}`); } };

const run = (m, cpu) => { cpu.rip = CODE; cpu.regs[4] = CODE + 0x1000n; m.write(cpu.regs[4], 8n, SENT); let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 20) throw new Error('runaway'); } };
const setup = (bytes, jit) => {
  const code = new Uint8Array(0x2000); code.set(bytes);
  const m = new Memory([{ base: CODE, bytes: code }]);
  if (jit) { m.jit = new Uint8Array(4); m.jitBase = CODE; m.jit[0] = 1; }
  const cpu = new CPU(m); for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
  return { m, cpu };
};

{ // a 5-byte immediate rewritten (mov eax, 1 -> mov eax, 2)
  const { m, cpu } = setup([0xb8, 1, 0, 0, 0, 0xc3], true);
  run(m, cpu); is('first decode', cpu.regs[0], 1n);
  m.write(CODE + 1n, 1n, 2n);
  run(m, cpu); is('patched immediate is seen', cpu.regs[0], 2n);
}
{ // a 10-byte movabs whose LAST byte changes: past the first 8, the second signature
  const { m, cpu } = setup([0x48, 0xb8, 1, 2, 3, 4, 5, 6, 7, 0x11, 0xc3], true);
  run(m, cpu); is('movabs first decode', cpu.regs[0], 0x1107060504030201n);
  m.write(CODE + 9n, 1n, 0x22n);
  run(m, cpu); is('patched byte 9 of a 10-byte insn is seen', cpu.regs[0], 0x2207060504030201n);
}
{ // the opcode itself rewritten, changing the instruction length (mov eax,1 ; ret  ->  xor eax,eax ; nop ; nop ; nop ; ret)
  const { m, cpu } = setup([0xb8, 1, 0, 0, 0, 0xc3], true);
  run(m, cpu); is('before relength', cpu.regs[0], 1n);
  for (const [i, b] of [[0, 0x31], [1, 0xc0], [2, 0x90], [3, 0x90], [4, 0x90]]) m.write(CODE + BigInt(i), 1n, BigInt(b));
  run(m, cpu); is('a patch that changes the length re-decodes', cpu.regs[0], 0n);
}
{ // a call target repatched (the JSC case): call stub1 -> call stub2
  // 400000: call +0x10 (e8 0b 00 00 00) ; ret      stub1 @ 400010: mov eax, 1 ; ret     stub2 @ 400020: mov eax, 2 ; ret
  const bytes = new Array(0x30).fill(0x90);
  bytes.splice(0, 6, 0xe8, 0x0b, 0, 0, 0, 0xc3);
  bytes.splice(0x10, 6, 0xb8, 1, 0, 0, 0, 0xc3);
  bytes.splice(0x20, 6, 0xb8, 2, 0, 0, 0, 0xc3);
  const { m, cpu } = setup(bytes, true);
  run(m, cpu); is('call to stub1', cpu.regs[0], 1n);
  m.write(CODE + 1n, 4n, 0x1bn);                 // rel32 now reaches stub2
  run(m, cpu); is('repatched call reaches stub2', cpu.regs[0], 2n);
}
{ // unmarked (static text) pays nothing and is not checked: the cache entry has no signature
  const { m, cpu } = setup([0xb8, 1, 0, 0, 0, 0xc3], false);
  run(m, cpu); is('static text runs', cpu.regs[0], 1n);
  is('static text carries no signature', cpu.icache.get(CODE).sig0, undefined);
}

console.log(`${pass}/${pass + fail} patched-code cases re-decoded by the interpreter`);
process.exit(fail ? 1 : 0);

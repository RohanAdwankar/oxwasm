// Differential: spill/reload narrowing must not change what a unit computes.
//
// The regression that motivates this file: liveness events were ordered by
// text position, and a read-modify-write first instruction like
// (local.set $r7 (i64.and (local.get $r7) …)) puts the def textually before
// its own use — the backward walk killed r7's entry liveness, the prologue
// reload of rdi was elided, and ld.so computed a hash from a zero-initialised
// local (bisected to f_1420c10 in the first narrowed sha256sum run). The def
// must fire at the local.set's closing paren, after its expression's uses.
//
// Each case runs interpreter vs narrowed-AOT on the same incoming registers,
// on code shaped to catch a specific narrowing hazard. Structural checks pin
// that narrowing actually engaged (an elided reload) and that the RMW entry
// reload survived — so a pass is evidence the analysis ran, not that it was
// disabled.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, SENT = 0xdeadbee0n;
const CASES = [
  // name, asm body (nasm, ends in ret), regs to compare, structural checks on the narrowed WAT
  ['rmw-entry', 'shl rdi, 4\nadd rdi, 3\nmov rax, rdi\nret\n', [0, 7],
    { mustHave: ['(local.set $r7 (i64.load (i32.const 56)))'] }],
  ['rmw-entry-16bit', 'add di, 1\nmov rax, rdi\nret\n', [0, 7],
    { mustHave: ['(local.set $r7 (i64.load (i32.const 56)))'] }],
  // rdi is fully defined before use: its entry reload must be ELIDED — this
  // is the check that narrowing actually engaged rather than being disabled
  ['dead-in-def-first', 'mov rdi, 5\nmov rax, rdi\nret\n', [0, 7],
    { mustNotHave: ['(local.set $r7 (i64.load (i32.const 56)))'] }],
  // a def on one path only must not kill liveness on the other
  ['conditional-def', 'test rsi, rsi\njz .keep\nmov rdi, 9\n.keep:\nmov rax, rdi\nret\n', [0, 6, 7],
    { mustHave: ['(local.set $r7 (i64.load (i32.const 56)))'] }],
];

let pass = 0, fail = 0;
for (const [name, asm, cmpRegs, struct] of CASES) {
  writeFileSync('/tmp/nrw.asm', 'BITS 64\n' + asm);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/nrw.bin', '/tmp/nrw.asm']);
  const bin = readFileSync('/tmp/nrw.bin');
  const code = new Uint8Array(0x10000); code.set(bin);

  globalThis.__narrow = true;
  let r;
  try { r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 }); }
  finally { delete globalThis.__narrow; }
  for (const s of struct.mustHave ?? []) if (!r.wat.includes(s)) {
    fail++; console.log(`STRUCT ${name}: narrowed WAT lost required "${s}"`); }
  for (const s of struct.mustNotHave ?? []) if (r.wat.includes(s)) {
    fail++; console.log(`STRUCT ${name}: narrowed WAT kept "${s}"`); }

  writeFileSync('/tmp/nrw.wat', r.wat);
  execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/nrw.wat', '-o', '/tmp/nrw.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/nrw.wasm'));

  const seed = [0x1111111111111111n, 0x2222n, 0x333333n, 0x4n, 0n, 0x5555n,
                0x66666666n, 0x777777777777n, 0x88n, 0x9999n, 0xaaaan, 0xbn,
                0xccccn, 0xdn, 0xeeeen, 0xfn];
  const m = new Memory([{ base: CODE, bytes: code.slice() }]);
  const cpu = new CPU(m);
  for (let i = 0; i < 16; i++) cpu.regs[i] = seed[i];
  cpu.regs[4] = CODE + 0x800n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
  let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 40) throw new Error('runaway'); }
  const want = cmpRegs.map(i => BigInt.asUintN(64, cpu.regs[i]));

  const wmem = new WebAssembly.Memory({ initial: 4096 });
  const stub = () => { throw new Error('escape'); };
  const inst = new WebAssembly.Instance(mod, { js: { mem: wmem }, env: { syscall: stub, callout: stub, deopt: stub } });
  const rv = new BigInt64Array(wmem.buffer, 0, 16);
  for (let i = 0; i < 16; i++) rv[i] = BigInt.asIntN(64, seed[i]);
  rv[4] = BigInt.asIntN(64, CODE + 0x800n);
  new DataView(wmem.buffer).setBigUint64(0x800, SENT, true);
  inst.exports[r.entryName]();
  const got = cmpRegs.map(i => BigInt.asUintN(64, rv[i]));
  if (got.every((x, i) => x === want[i])) pass++;
  else { fail++;
    console.log(`AOT MISMATCH ${name}: interp ${want.map(x=>x.toString(16))} narrowed-aot ${got.map(x=>x.toString(16))}`); }
}
console.log(`${pass}/${CASES.length} narrowing cases bit-exact (narrowed AOT vs interpreter)`);
if (fail) process.exit(1);

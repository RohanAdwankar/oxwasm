// Differential: mul/imul overflow flags (CF=OF) consumed by jc/jo/setc, and
// the bt/bts/btr/btc MEMORY forms including bit-string addressing (register
// bit offsets beyond the word, negative offsets) — glib's g_bit_lock shape.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, DATA = 0x400800n, SENT = 0xdeadbee0n;
const asm = (body) => {
  writeFileSync('/tmp/mb.asm', 'BITS 64\n' + body);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/mb.bin', '/tmp/mb.asm']);
  const b = readFileSync('/tmp/mb.bin'); const c = new Uint8Array(0x1000); c.set(b); return c;
};
const CASES = [
  ['mul64-jc',  `mov rax, rdi
mul rsi
jc t
mov rax, 1
ret
t: mov rax, 2
ret`],
  ['imul64-jo', `mov rax, rdi
imul rsi
jo t
mov rax, 1
ret
t: mov rax, 2
ret`],
  ['mul32-setc',`mov rax, rdi
mul esi
setc al
movzx rax, al
ret`],
  ['imul32-jno',`mov rax, rdi
imul esi
jno t
mov rax, 1
ret
t: mov rax, 2
ret`],
  ['bts-mem-reg',`mov rax, 0x400800
bts [rax], rsi
setc al
movzx rax, al
ret`],
  ['btr-mem-reg',`mov rax, 0x400800
btr qword [rax], rsi
mov rax, [0x400800]
ret`],
  ['bt-mem-imm',`mov rax, 0x400800
bt qword [rax], 37
setc al
movzx rax, al
ret`],
  ['btc-mem-dword',`mov rax, 0x400800
btc dword [rax], esi
mov rax, [0x400800]
ret`],
];
const MULV = [0n, 1n, 2n, 63n, 64n, 65n, 100n, 0xFFFFFFFFn, 0x100000000n, 0xFFFFFFFFFFFFFFFFn, 0x8000000000000000n];
// memory-bt offsets must stay inside the 4KB test image (bit-string
// addressing walks words away from the base): include negatives via wraparound
const BTV = [0n, 1n, 37n, 63n, 64n, 65n, 100n, 127n, 0xFFFFFFFFFFFFFFFFn, 0xFFFFFFFFFFFFFFC0n];
let pass = 0, fail = 0;
for (const [name, body] of CASES) {
  const vals = name.includes('mem') ? BTV : MULV;
  const code = asm(body);
  let r;
  try { r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 }); }
  catch (e) { fail++; console.log(`COMPILE-FAIL ${name}: ${e.message}`); continue; }
  writeFileSync('/tmp/mb.wat', r.wat); execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/mb.wat', '-o', '/tmp/mb.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/mb.wasm'));
  for (const a of vals) for (const b of vals) {
    const mkcode = () => { const c = code.slice(); const dv = new DataView(c.buffer);
      dv.setBigUint64(0x800, 0xA5A5_5A5A_F00D_BEEFn, true); return c; };
    const m = new Memory([{ base: CODE, bytes: mkcode() }]);
    const cpu = new CPU(m);
    for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
    cpu.regs[7] = a; cpu.regs[6] = b;
    cpu.regs[4] = CODE + 0x700n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
    let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 500) throw new Error('runaway ' + name); }
    const oracle = BigInt.asUintN(64, cpu.regs[0]);
    const oracleMem = m.read(DATA, 8n);
    const mem = new WebAssembly.Memory({ initial: 4096 });
    const stub = () => { throw new Error('escape'); };
    const inst = new WebAssembly.Instance(mod, { js: { mem }, env: { syscall: stub, callout: stub, deopt: stub } });
    const rv = new BigInt64Array(mem.buffer, 0, 16);
    const dv = new DataView(mem.buffer);
    // code+data image lives at wasm offset (guest-CODE), ramBase 0
    new Uint8Array(mem.buffer).set(mkcode(), Number(CODE - CODE));
    dv.setBigUint64(Number(DATA - CODE), 0xA5A5_5A5A_F00D_BEEFn, true);
    for (let q = 0; q < 16; q++) rv[q] = 0n;
    rv[7] = BigInt.asIntN(64, a); rv[6] = BigInt.asIntN(64, b);
    rv[4] = BigInt.asIntN(64, CODE + 0x700n);
    dv.setBigUint64(0x700, SENT, true);
    const exit = BigInt.asUintN(64, inst.exports[r.entryName]());
    const aot = BigInt.asUintN(64, rv[0]);
    const aotMem = dv.getBigUint64(Number(DATA - CODE), true);
    if (exit === SENT && aot === oracle && aotMem === oracleMem) pass++;
    else { fail++; if (fail < 10) console.log(`MISMATCH ${name} rdi=${a.toString(16)} rsi=${b.toString(16)}: oracle=${oracle.toString(16)}/${oracleMem.toString(16)} aot=${aot.toString(16)}/${aotMem.toString(16)} exit=${exit.toString(16)}`); }
  }
}
console.log(`\n${pass}/${pass + fail} mul-flags + memory-bt results bit-exact (AOT vs interpreter)`);
if (fail) process.exit(1);

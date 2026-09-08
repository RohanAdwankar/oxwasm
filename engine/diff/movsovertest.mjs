// Differential: `rep movs` where source and destination OVERLAP.
//
// x86's rep movs is an element-at-a-time copy, and wasm's memory.copy is
// memmove. Those are the same thing only when the ranges do not overlap, or
// when they overlap in the direction the copy runs away from.
//
// Forward (DF=0), dst above src by d < count: iteration k reads src+k, and
// iteration k-d already WROTE that byte. The copy therefore replicates the
// first d bytes as a repeating pattern to the end. memmove reads the original
// every time and does not. `rep movsb` with rsi = rdi - 1 is the classic
// byte-fill idiom and lands exactly on this.
//
// The interpreter has always guarded it (`overlapUp` falls back to the exact
// per-element loop). The emitter did not: it lowered every `rep movsb` to one
// memory.copy. That is the compile-or-refuse invariant broken in the direction
// that matters - not a refusal, an accepted function that answers differently
// from the oracle.
//
// Sizes 2/4/8 use the strided loop rather than memory.copy, so they are here
// as the control: they should already agree, and a failure there means the
// loop is wrong too rather than just the bulk path.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

// BUF sits above FTMAP (0x10000), which the engine's own counters use: a
// buffer laid over the chain-depth word reads back as a mismatch the engine
// did not cause.
const CODE = 0x400000n, SENT = 0xdeadbee0n, BUF = 0x420000n;
const asmOf = (body) => {
  writeFileSync('/tmp/mo.asm', 'BITS 64\n' + body);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/mo.bin', '/tmp/mo.asm']);
  const b = readFileSync('/tmp/mo.bin'); const c = new Uint8Array(0x30000); c.set(b); return c;
};

// rsi and rdi come in as guest addresses; rcx is the element count.
const CASES = [
  ['movsb', 'rep movsb\nret', 1],
  ['movsw', 'rep movsw\nret', 2],
  ['movsd', 'rep movsd\nret', 4],
  ['movsq', 'rep movsq\nret', 8],
];

// deltas in ELEMENTS between dst and src, signed. 0 is aliasing; positive is
// dst above src (the case memmove gets wrong); negative is dst below src
// (where forward element copy and memmove agree, so it must keep agreeing).
const DELTAS = [-9, -4, -1, 0, 1, 2, 3, 7, 16];
const COUNTS = [0, 1, 2, 3, 8, 17];

let pass = 0, fail = 0, refused = 0;
for (const [name, body, S] of CASES) {
  const code = asmOf(body);
  let r;
  try { r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 }); }
  catch (e) { refused++; console.log(`  REFUSED ${name}: ${e.message.slice(0, 70)}`); continue; }
  writeFileSync('/tmp/mo.wat', r.wat);
  execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/mo.wat', '-o', '/tmp/mo.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/mo.wasm'));

  const SPAN = 256;                       // bytes of buffer both engines get
  const seed = (i) => (i * 31 + 7) & 0xFF;

  for (const dEl of DELTAS) for (const cnt of COUNTS) {
    // src sits far enough into the buffer that a negative delta stays inside
    const srcOff = 64, dstOff = srcOff + dEl * S;
    const src = BUF + BigInt(srcOff), dst = BUF + BigInt(dstOff);

    const m = new Memory([{ base: CODE, bytes: code.slice() }]);
    for (let i = 0; i < SPAN; i++) m.write(BUF + BigInt(i), 1n, BigInt(seed(i)));
    const cpu = new CPU(m);
    for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
    cpu.regs[6] = src; cpu.regs[7] = dst; cpu.regs[1] = BigInt(cnt);
    cpu.regs[4] = CODE + 0x800n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
    let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 5000) throw new Error('runaway ' + name); }
    const wantMem = []; for (let i = 0; i < SPAN; i++) wantMem.push(Number(m.read(BUF + BigInt(i), 1n)));
    const wantReg = [1, 6, 7].map(q => BigInt.asUintN(64, cpu.regs[q]));

    const mem = new WebAssembly.Memory({ initial: 4096 });
    const stub = () => { throw new Error('escape'); };
    const inst = new WebAssembly.Instance(mod, { js: { mem, ftab: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }) },
                                                 env: { syscall: stub, callout: stub, deopt: stub, loophot: stub } });
    const rv = new BigInt64Array(mem.buffer, 0, 16), dv = new DataView(mem.buffer), u8 = new Uint8Array(mem.buffer);
    u8.set(code, 0);
    const bufOff = Number(BUF - CODE);    // ramBase 0, guestBase CODE
    for (let i = 0; i < SPAN; i++) u8[bufOff + i] = seed(i);
    for (let q = 0; q < 16; q++) rv[q] = 0n;
    rv[6] = BigInt.asIntN(64, src); rv[7] = BigInt.asIntN(64, dst); rv[1] = BigInt(cnt);
    rv[4] = BigInt.asIntN(64, CODE + 0x800n);
    dv.setBigUint64(0x800, SENT, true);
    inst.exports[r.entryName]();
    const gotMem = []; for (let i = 0; i < SPAN; i++) gotMem.push(u8[bufOff + i]);
    const gotReg = [1, 6, 7].map(q => BigInt.asUintN(64, rv[q]));

    const memBad = gotMem.findIndex((v, i) => v !== wantMem[i]);
    const regBad = gotReg.findIndex((v, i) => v !== wantReg[i]);
    if (memBad < 0 && regBad < 0) pass++;
    else {
      fail++;
      if (fail <= 6) {
        const what = memBad >= 0
          ? `buffer byte ${memBad}: oracle ${wantMem[memBad]} aot ${gotMem[memBad]}`
          : `reg ${['rcx','rsi','rdi'][regBad]}: oracle ${wantReg[regBad].toString(16)} aot ${gotReg[regBad].toString(16)}`;
        console.log(`  MISMATCH ${name} dst-src=${dEl} elements rcx=${cnt}: ${what}`);
      }
    }
  }
}
console.log(`\n${pass}/${pass + fail} overlapping rep movs results match the interpreter (4 widths x ${DELTAS.length} overlaps x ${COUNTS.length} counts)`);
if (refused) console.log(`${refused} refused`);
if (fail || refused) process.exit(1);

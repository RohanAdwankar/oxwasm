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
//
// Every case runs twice: once plain, and once behind a `std`, which is the
// only way to reach the emitter's backward path. Backward has the mirror
// hazard - it runs into the source when rsi is above rdi - so it needs the
// same overlap sweep, and the `std` variant also proves the function compiles
// at all (it used to be refused whole).
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
// rax is the fill byte for stos and the scanned value for scas. seed() walks
// every byte value across the buffer (31 and 256 are coprime), so the two scas
// entries below are chosen to sit inside reach one going up and one going down
// - a scan that can never match only ever tests the rcx=0 exit.
const seedAt = (i) => (i * 31 + 7) & 0xFF;
const OPS = [
  ['movsb', 'rep movsb', 1, 0xA5A5A5A5A5A5A5A5n],
  ['movsw', 'rep movsw', 2, 0xA5A5A5A5A5A5A5A5n],
  ['movsd', 'rep movsd', 4, 0xA5A5A5A5A5A5A5A5n],
  ['movsq', 'rep movsq', 8, 0xA5A5A5A5A5A5A5A5n],
  ['stosb', 'rep stosb', 1, 0xA5A5A5A5A5A5A5A5n],
  ['stosq', 'rep stosq', 8, 0xA5A5A5A5A5A5A5A5n],
  ['repe-cmpsb',   'repe cmpsb',   1, 0n],
  ['repne-cmpsb',  'repne cmpsb',  1, 0n],
  ['repe-cmpsq',   'repe cmpsq',   8, 0n],
  ['repne-scasb-up',   'repne scasb', 1, BigInt(seedAt(135))],
  ['repne-scasb-down', 'repne scasb', 1, BigInt(seedAt(121))],
  ['repe-scasb',       'repe scasb',  1, BigInt(seedAt(128))],
];
// `cld` at the end so the unit leaves DF=0 either way and only the string op
// sees the difference; without it the two runs would also differ in DF on exit,
// which the test would report as a register mismatch for the wrong reason.
// `xor r11, r11` first so the flags have a known state going in: movs and stos
// do not touch flags, and without it the setcc trio below would read whatever
// each engine happened to start with and differ for a reason that is not the
// string op. The setcc trio is how repe/repne's terminating comparison gets
// checked - the pointers alone would not catch a sign error in it.
const CASES = [];
for (const [n, body, S, ax] of OPS) {
  const tail = 'sete r8b\nsetb r9b\nseta r10b\nret';
  CASES.push([n, `xor r11, r11\n${body}\n${tail}`, S, ax]);
  CASES.push([n + '-std', `xor r11, r11\nstd\n${body}\ncld\n${tail}`, S, ax]);
}

// deltas in ELEMENTS between dst and src, signed. 0 is aliasing; positive is
// dst above src (the case memmove gets wrong); negative is dst below src
// (where forward element copy and memmove agree, so it must keep agreeing).
const DELTAS = [-9, -4, -1, 0, 1, 2, 3, 7, 16];
const COUNTS = [0, 1, 2, 3, 8, 17];
// rcx/rsi/rdi, then the three setcc bytes (ZF, CF, above)
const REGS = [1, 6, 7, 8, 9, 10], REGN = ['rcx', 'rsi', 'rdi', 'sete', 'setb', 'seta'];

let pass = 0, fail = 0, refused = 0, escaped = 0;
for (const [name, body, S, ax] of CASES) {
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
    const srcOff = 128, dstOff = srcOff + dEl * S;
    const src = BUF + BigInt(srcOff), dst = BUF + BigInt(dstOff);

    const m = new Memory([{ base: CODE, bytes: code.slice() }]);
    for (let i = 0; i < SPAN; i++) m.write(BUF + BigInt(i), 1n, BigInt(seed(i)));
    const cpu = new CPU(m);
    for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
    cpu.regs[6] = src; cpu.regs[7] = dst; cpu.regs[1] = BigInt(cnt); cpu.regs[0] = ax;
    cpu.regs[4] = CODE + 0x800n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
    let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 5000) throw new Error('runaway ' + name); }
    const wantMem = []; for (let i = 0; i < SPAN; i++) wantMem.push(Number(m.read(BUF + BigInt(i), 1n)));
    const wantReg = REGS.map(q => BigInt.asUintN(64, cpu.regs[q]));

    const mem = new WebAssembly.Memory({ initial: 4096 });
    const stub = () => { throw new Error('escape'); };
    const inst = new WebAssembly.Instance(mod, { js: { mem, ftab: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }) },
                                                 env: { syscall: stub, callout: stub, deopt: stub, loophot: stub, codewrite: stub } });
    const rv = new BigInt64Array(mem.buffer, 0, 16), dv = new DataView(mem.buffer), u8 = new Uint8Array(mem.buffer);
    u8.set(code, 0);
    const bufOff = Number(BUF - CODE);    // ramBase 0, guestBase CODE
    for (let i = 0; i < SPAN; i++) u8[bufOff + i] = seed(i);
    for (let q = 0; q < 16; q++) rv[q] = 0n;
    rv[6] = BigInt.asIntN(64, src); rv[7] = BigInt.asIntN(64, dst); rv[1] = BigInt(cnt);
    rv[0] = BigInt.asIntN(64, ax);
    rv[4] = BigInt.asIntN(64, CODE + 0x800n);
    dv.setBigUint64(0x800, SENT, true);
    // rep cmps/scas with rcx=0 must leave the flags untouched, which the unit
    // cannot express when the incoming flag state has a different (kind,size);
    // it escapes to the interpreter instead. That is the engine declining
    // correctly, not a result to compare, and it is the only escape this
    // fixture should ever see - anything else rethrows.
    try { inst.exports[r.entryName](); }
    catch (err) {
      if (err.message === 'escape' && /cmps|scas/.test(name) && cnt === 0) { escaped++; continue; }
      throw err;
    }
    const gotMem = []; for (let i = 0; i < SPAN; i++) gotMem.push(u8[bufOff + i]);
    const gotReg = REGS.map(q => BigInt.asUintN(64, rv[q]));

    const memBad = gotMem.findIndex((v, i) => v !== wantMem[i]);
    const regBad = gotReg.findIndex((v, i) => v !== wantReg[i]);
    if (memBad < 0 && regBad < 0) pass++;
    else {
      fail++;
      if (fail <= 6) {
        const what = memBad >= 0
          ? `buffer byte ${memBad}: oracle ${wantMem[memBad]} aot ${gotMem[memBad]}`
          : `reg ${REGN[regBad]}: oracle ${wantReg[regBad].toString(16)} aot ${gotReg[regBad].toString(16)}`;
        console.log(`  MISMATCH ${name} dst-src=${dEl} elements rcx=${cnt}: ${what}`);
      }
    }
  }
}
console.log(`\n${pass}/${pass + fail} rep string-op results match the interpreter across overlap and direction ` +
            `(${OPS.length} ops x forward and std x ${DELTAS.length} overlaps x ${COUNTS.length} counts)`);
if (escaped) console.log(`${escaped} rcx=0 cmps/scas escapes to the interpreter (correct: hardware leaves the flags alone there)`);
if (refused) console.log(`${refused} refused`);
if (fail || refused) process.exit(1);

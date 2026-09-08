// Differential: the PACKED float conversions, cvtps2pd and cvtpd2ps.
//
// `0F 5A` is four instructions wearing one opcode: the scalar pair the emitter
// already had (cvtss2sd, cvtsd2ss) and the packed pair it refused. Refusing
// them was invisible to the sweep - nothing in 170 cases tiered a function
// containing one - and visible to a static census over the shared libraries,
// where they were the largest single cause.
//
// The two rules differ in more than width, which is where a lane mistake would
// hide: cvtps2pd widens the LOW TWO f32 lanes and replaces the whole register,
// while cvtpd2ps narrows two f64 into the low two f32 lanes and ZEROES the
// upper half. So the cases below read back all 128 bits, not just the part the
// instruction obviously writes.
//
// The values are chosen for the edges of the narrowing direction, which is the
// one that can lose: a double too large for a float, one too small, the
// infinities, a NaN, and a negative zero whose sign must survive.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, SENT = 0xdeadbee0n;
const asm = (body) => {
  writeFileSync('/tmp/cv.asm', 'BITS 64\n' + body);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/cv.bin', '/tmp/cv.asm']);
  const b = readFileSync('/tmp/cv.bin'); const c = new Uint8Array(0x2000); c.set(b); return c;
};

// xmm0 is seeded from memory at 0x400800; the result is written to 0x400820
// and folded into rax so a single 64-bit compare covers both halves.
const SEED = 'movdqu xmm0, [0x400800]\n';
const TAIL = 'movdqu [0x400820], xmm1\nmov rax, [0x400820]\nxor rax, [0x400828]\nret';
const CASES = [
  ['cvtps2pd-reg', `${SEED}cvtps2pd xmm1, xmm0\n${TAIL}`],
  ['cvtps2pd-mem', `cvtps2pd xmm1, qword [0x400800]\n${TAIL}`],
  ['cvtpd2ps-reg', `${SEED}cvtpd2ps xmm1, xmm0\n${TAIL}`],
  ['cvtpd2ps-mem', `cvtpd2ps xmm1, oword [0x400800]\n${TAIL}`],
  // the scalar pair alongside them, so a change to this case cannot break the
  // forms that already worked without the test noticing
  ['cvtss2sd', `${SEED}cvtss2sd xmm1, xmm0\n${TAIL}`],
  ['cvtsd2ss', `${SEED}cvtsd2ss xmm1, xmm0\n${TAIL}`],
];

const f64 = (x) => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, x, true); return b.getBigUint64(0, true); };
const f32 = (x) => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, x, true); return BigInt(b.getUint32(0, true)); };
// each entry is the full 128 bits xmm0 starts with
const SEEDS = [
  // two doubles: ordinary, and a pair that is exactly representable as floats
  f64(1.5) | (f64(-2.25) << 64n),
  f64(3.14159265358979) | (f64(2.718281828459045) << 64n),
  // doubles that do NOT fit a float: overflow to infinity, and underflow to zero
  f64(1e300) | (f64(1e-300) << 64n),
  f64(-1e300) | (f64(-1e-300) << 64n),
  // the infinities and a NaN, whose quieting must match
  f64(Infinity) | (f64(-Infinity) << 64n),
  f64(NaN) | (f64(-0) << 64n),
  // four floats, for the widening direction: two normal, then a denormal and
  // an infinity in the lanes cvtps2pd ignores, so a wrong lane pick shows up
  f32(1.5) | (f32(-2.25) << 32n) | (f32(1e-42) << 64n) | (f32(Infinity) << 96n),
  f32(Infinity) | (f32(NaN) << 32n) | (f32(0) << 64n) | (f32(-0) << 96n),
  0n, (1n << 128n) - 1n,
];

let pass = 0, fail = 0, refused = 0;
for (const [name, body] of CASES) {
  const code = asm(body);
  let r;
  try { r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 }); }
  catch (e) { refused++; console.log(`  REFUSED ${name}: ${e.message.slice(0, 60)}`); continue; }
  writeFileSync('/tmp/cv.wat', r.wat);
  execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/cv.wat', '-o', '/tmp/cv.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/cv.wasm'));

  for (const seed of SEEDS) {
    const lo = seed & 0xFFFFFFFFFFFFFFFFn, hi = (seed >> 64n) & 0xFFFFFFFFFFFFFFFFn;

    const m = new Memory([{ base: CODE, bytes: code.slice() }]);
    m.write(CODE + 0x800n, 8n, lo); m.write(CODE + 0x808n, 8n, hi);
    const cpu = new CPU(m);
    for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
    cpu.regs[4] = CODE + 0x700n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
    let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 300) throw new Error('runaway ' + name); }
    const oracle = BigInt.asUintN(64, cpu.regs[0]);

    const mem = new WebAssembly.Memory({ initial: 4096 });
    const stub = () => { throw new Error('escape'); };
    const inst = new WebAssembly.Instance(mod, { js: { mem, ftab: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }) },
                                                 env: { syscall: stub, callout: stub, deopt: stub, loophot: stub } });
    const rv = new BigInt64Array(mem.buffer, 0, 16), dv = new DataView(mem.buffer);
    new Uint8Array(mem.buffer).set(code, 0);
    dv.setBigUint64(0x800, lo, true); dv.setBigUint64(0x808, hi, true);
    for (let q = 0; q < 16; q++) rv[q] = 0n;
    rv[4] = BigInt.asIntN(64, CODE + 0x700n);
    dv.setBigUint64(0x700, SENT, true);
    inst.exports[r.entryName]();
    const aot = BigInt.asUintN(64, rv[0]);

    if (aot === oracle) pass++;
    else { fail++; if (fail <= 8) console.log(`  MISMATCH ${name} seed=${seed.toString(16)}: oracle=${oracle.toString(16)} aot=${aot.toString(16)}`); }
  }
}
console.log(`\n${pass}/${pass + fail} packed and scalar 0F 5A conversions bit-exact (AOT vs interpreter), ${SEEDS.length} operand sets`);
if (refused) console.log(`${refused} refused`);
if (fail || refused) process.exit(1);

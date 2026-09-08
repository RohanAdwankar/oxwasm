// Differential: the packed and scalar float arithmetic of 0F 51/58/59/5C/5D/5E/5F.
//
// One opcode is four instructions and the prefix says which: no prefix is
// packed single (addps), 66 is packed DOUBLE (addpd), F3 is scalar single
// (addss), F2 is scalar double (addsd). The emitter chose its wasm lane type
// from the F2 prefix alone, which is right for the scalar pair and wrong for
// every packed-double form: addpd, subpd, mulpd, divpd, minpd, maxpd and
// sqrtpd all computed FOUR SINGLE-PRECISION lanes where the guest asked for
// two doubles.
//
// That shipped. The interpreter had it right, so it is a translator bug, and
// no directed test covered it because every vector float case in this suite
// was written for the single-precision form.
//
// Found by diff/fuzzaot.mjs, which generates random programs and compares the
// two engines - it produced a `mulpd` divergence on its first run with vector
// instructions in the generator.
//
// Hardware is the oracle, not the interpreter: min/max and NaN operands are
// exactly where an interpreter can be confidently wrong, so both engines are
// checked against the CPU.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, BUF = 0x420000n, SENT = 0xdeadbee0n;
const OPS = ['addps','subps','mulps','divps','minps','maxps','sqrtps',
             'addpd','subpd','mulpd','divpd','minpd','maxpd','sqrtpd',
             'addss','subss','mulss','divss','minss','maxss','sqrtss',
             'addsd','subsd','mulsd','divsd','minsd','maxsd','sqrtsd'];

// Operand pairs written as raw 128-bit values, so the same bytes reach the
// CPU and both engines. min/max on a NaN, on equal-magnitude opposite zeros,
// and on infinities are where x86 and a naive lowering diverge.
const f64 = (x) => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, x, true); return b.getBigUint64(0, true); };
const f32 = (x) => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, x, true); return BigInt(b.getUint32(0, true)); };
const PAIRS = [
  // ordinary values, distinct in every lane
  [f64(1.5) | (f64(-2.25) << 64n), f64(3.5) | (f64(7.125) << 64n)],
  // as four floats, so the single-precision forms get their own spread
  [f32(1.5) | (f32(-2.25) << 32n) | (f32(3.5) << 64n) | (f32(-7.125) << 96n),
   f32(0.5) | (f32(4.0) << 32n) | (f32(-1.25) << 64n) | (f32(2.0) << 96n)],
  // zeros of both signs: x86 min/max return the SECOND source when the two
  // compare equal, which is why the order of the wasm operands matters
  [f64(0) | (f64(-0) << 64n), f64(-0) | (f64(0) << 64n)],
  // a NaN in the first source, then in the second
  [f64(NaN) | (f64(1) << 64n), f64(2) | (f64(NaN) << 64n)],
  [f64(2) | (f64(3) << 64n), f64(NaN) | (f64(NaN) << 64n)],
  // infinities, and a division that makes one
  [f64(Infinity) | (f64(-Infinity) << 64n), f64(0) | (f64(2) << 64n)],
  // values that only fit as doubles, so a 32-bit lowering cannot coincide
  [f64(1e300) | (f64(-1e-300) << 64n), f64(3e300) | (f64(7e-300) << 64n)],
  // the bytes fuzzaot itself seeds, which is where this was found
  [0n, 0n],
];
const sb = (i) => (i * 31 + 7) & 0xFF;
{ let a = 0n, b = 0n;
  for (let i = 15; i >= 0; i--) { a = (a << 8n) | BigInt(sb(i)); b = (b << 8n) | BigInt(sb(80 + i)); }
  PAIRS[PAIRS.length - 1] = [a, b]; }

const hex = (v) => v.toString(16).padStart(32, '0');
let bad = 0, n = 0, refused = 0;
for (const op of OPS) {
  const two = op.startsWith('sqrt');
  const body = `movdqu xmm0, [0x420000]\nmovdqu xmm5, [0x420010]\n${op} xmm0, xmm5\nmovdqu [0x420100], xmm0\nret`;
  writeFileSync('/tmp/pf.asm', 'BITS 64\n' + body);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/pf.bin', '/tmp/pf.asm']);
  const code = new Uint8Array(0x30000); code.set(readFileSync('/tmp/pf.bin'));
  let r;
  try { r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 }); }
  catch (e) { refused++; console.log(`  REFUSED ${op}: ${e.message.slice(0, 50)}`); continue; }
  writeFileSync('/tmp/pf.wat', r.wat);
  execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/pf.wat', '-o', '/tmp/pf.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/pf.wasm'));

  for (const [A, B] of PAIRS) {
    // hardware
    const C = `int main(){unsigned char b[300] __attribute__((aligned(16)));
      unsigned long long*q=(unsigned long long*)b;
      q[0]=0x${(A & ((1n<<64n)-1n)).toString(16)}ULL; q[1]=0x${(A>>64n).toString(16)}ULL;
      q[2]=0x${(B & ((1n<<64n)-1n)).toString(16)}ULL; q[3]=0x${(B>>64n).toString(16)}ULL;
      asm volatile("movdqu %1,%%xmm0\\n\\tmovdqu %2,%%xmm5\\n\\t${op} %%xmm5,%%xmm0\\n\\tmovdqu %%xmm0,%0"
        :"=m"(b[256]):"m"(b[0]),"m"(b[16]):"xmm0","xmm5");
      for(int i=271;i>=256;i--) __builtin_printf("%02x", b[i]); __builtin_printf("\\n"); return 0;}`;
    writeFileSync('/tmp/pf.c', C);
    execFileSync('gcc', ['-O1', '-o', '/tmp/pfbin', '/tmp/pf.c']);
    const hw = execFileSync('/tmp/pfbin').toString().trim();

    // interpreter
    const m = new Memory([{ base: CODE, bytes: code.slice() }]);
    m.write(BUF, 8n, A & ((1n<<64n)-1n)); m.write(BUF + 8n, 8n, A >> 64n);
    m.write(BUF + 16n, 8n, B & ((1n<<64n)-1n)); m.write(BUF + 24n, 8n, B >> 64n);
    const cpu = new CPU(m);
    for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
    cpu.regs[4] = CODE + 0x1000n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
    let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 50) throw new Error('runaway ' + op); }
    const it = hex((m.read(BUF + 0x108n, 8n) << 64n) | m.read(BUF + 0x100n, 8n));

    // translated
    const mem = new WebAssembly.Memory({ initial: 4096 });
    const stub = () => { throw new Error('escape'); };
    const inst = new WebAssembly.Instance(mod, { js: { mem, ftab: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }) },
                                                 env: { syscall: stub, callout: stub, deopt: stub, loophot: stub } });
    const rv = new BigInt64Array(mem.buffer, 0, 16), dv = new DataView(mem.buffer);
    new Uint8Array(mem.buffer).set(code, 0);
    const off = Number(BUF - CODE);
    dv.setBigUint64(off, A & ((1n<<64n)-1n), true); dv.setBigUint64(off + 8, A >> 64n, true);
    dv.setBigUint64(off + 16, B & ((1n<<64n)-1n), true); dv.setBigUint64(off + 24, B >> 64n, true);
    for (let q = 0; q < 16; q++) rv[q] = 0n;
    rv[4] = BigInt.asIntN(64, CODE + 0x1000n);
    dv.setBigUint64(0x1000, SENT, true);
    inst.exports[r.entryName]();
    const ao = hex((dv.getBigUint64(off + 0x108, true) << 64n) | dv.getBigUint64(off + 0x100, true));

    n++;
    if (hw !== it || hw !== ao) {
      bad++;
      if (bad <= 10) console.log(`  ${op.padEnd(7)} a=${hex(A).slice(0,12)}… b=${hex(B).slice(0,12)}…\n` +
        `      hw     ${hw}` + (it !== hw ? `\n      interp ${it}` : '') + (ao !== hw ? `\n      aot    ${ao}` : ''));
    }
  }
}
console.log(`\n${n - bad}/${n} packed and scalar float results match hardware in BOTH engines ` +
            `(${OPS.length} forms x ${PAIRS.length} operand pairs)`);
if (refused) console.log(`${refused} refused`);
if (bad || refused) process.exit(1);

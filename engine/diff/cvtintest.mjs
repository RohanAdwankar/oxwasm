// Differential: the float-to-integer conversions of 0F 5B, against hardware.
//
// cvtps2dq and cvttps2dq were refused because wasm's saturating conversion is
// not x86's rule and "close" is not the same. x86 yields 0x80000000 - the
// integer indefinite - for a NaN or anything that will not fit; wasm's
// trunc_sat yields 0 for a NaN and clamps to INT_MAX or INT_MIN. They are now
// built from trunc_sat plus a per-lane range test, so the two agree exactly.
//
// The two differ in more than range: 66 rounds to NEAREST-EVEN and F3
// truncates. That caught a bug in the ORACLE - the interpreter used
// Math.round, which breaks ties upward, so 0.5 came back 1 where hardware
// gives 0, 2.5 gave 3 where hardware gives 2, and -1.5 gave -1 where hardware
// gives -2. Both engines are checked against the CPU here for that reason.
//
// The values are chosen for the two edges that matter: exact ties in both
// signs, and the boundary of the representable range from either side.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, BUF = 0x420000n, SENT = 0xdeadbee0n;
const f32 = (x) => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, x, true); return BigInt(b.getUint32(0, true)); };
const ROWS = [
  [0.5, 1.5, 2.5, -0.5],                      // ties, where half-even and half-up part
  [-1.5, -2.5, 3.49, -3.49],
  [2147483648, -2147483648, 1e30, -1e30],     // at the boundary and far past it
  [2147483520, -2147483648, 2147483647, -2147483904],   // the nearest representable floats to it
  [NaN, Infinity, -Infinity, 0],
  [1.9, -1.9, 8388609, -8388609],
  [-0, 1e-40, -1e-40, 0.49999997],            // signed zero, denormals, and just under a half
];
const OPS = ['cvtps2dq', 'cvttps2dq', 'cvtdq2ps'];
const hex = (v) => v.toString(16).padStart(32, '0');

let bad = 0, n = 0, refused = 0;
for (const op of OPS) {
  const body = `movdqu xmm0, [0x420000]\n${op} xmm0, xmm0\nmovdqu [0x420100], xmm0\nret`;
  writeFileSync('/tmp/ci.asm', 'BITS 64\n' + body);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/ci.bin', '/tmp/ci.asm']);
  const code = new Uint8Array(0x30000); code.set(readFileSync('/tmp/ci.bin'));
  let r;
  try { r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 }); }
  catch (e) { refused++; console.log(`  REFUSED ${op}: ${e.message.slice(0, 60)}`); continue; }
  writeFileSync('/tmp/ci.wat', r.wat);
  execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/ci.wat', '-o', '/tmp/ci.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/ci.wasm'));

  for (const row of ROWS) {
    // cvtdq2ps reads its lanes as integers, so feed it the same bit patterns
    const A = op === 'cvtdq2ps'
      ? row.reduce((a, x, i) => a | (BigInt.asUintN(32, BigInt(Math.trunc(Number.isFinite(x) ? x : 0))) << BigInt(32 * i)), 0n)
      : row.reduce((a, x, i) => a | (f32(x) << BigInt(32 * i)), 0n);

    const C = `int main(){unsigned char b[300] __attribute__((aligned(16)));unsigned long long*q=(unsigned long long*)b;
      q[0]=0x${(A & ((1n<<64n)-1n)).toString(16)}ULL; q[1]=0x${(A>>64n).toString(16)}ULL;
      asm volatile("movdqu %1,%%xmm0\\n\\t${op} %%xmm0,%%xmm0\\n\\tmovdqu %%xmm0,%0":"=m"(b[256]):"m"(b[0]):"xmm0");
      for(int i=271;i>=256;i--) __builtin_printf("%02x", b[i]); __builtin_printf("\\n"); return 0;}`;
    writeFileSync('/tmp/ci.c', C);
    execFileSync('gcc', ['-O1', '-o', '/tmp/cibin', '/tmp/ci.c']);
    const hw = execFileSync('/tmp/cibin').toString().trim();

    const m = new Memory([{ base: CODE, bytes: code.slice() }]);
    m.write(BUF, 8n, A & ((1n<<64n)-1n)); m.write(BUF + 8n, 8n, A >> 64n);
    const cpu = new CPU(m);
    for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
    cpu.regs[4] = CODE + 0x1000n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
    let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 50) throw new Error('runaway ' + op); }
    const it = hex((m.read(BUF + 0x108n, 8n) << 64n) | m.read(BUF + 0x100n, 8n));

    const mem = new WebAssembly.Memory({ initial: 4096 });
    const stub = () => { throw new Error('escape'); };
    const inst = new WebAssembly.Instance(mod, { js: { mem, ftab: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }) },
                                                 env: { syscall: stub, callout: stub, deopt: stub, loophot: stub, codewrite: stub } });
    const rv = new BigInt64Array(mem.buffer, 0, 16), dv = new DataView(mem.buffer);
    new Uint8Array(mem.buffer).set(code, 0);
    const off = Number(BUF - CODE);
    dv.setBigUint64(off, A & ((1n<<64n)-1n), true); dv.setBigUint64(off + 8, A >> 64n, true);
    for (let q = 0; q < 16; q++) rv[q] = 0n;
    rv[4] = BigInt.asIntN(64, CODE + 0x1000n);
    dv.setBigUint64(0x1000, SENT, true);
    inst.exports[r.entryName]();
    const ao = hex((dv.getBigUint64(off + 0x108, true) << 64n) | dv.getBigUint64(off + 0x100, true));

    n++;
    if (hw !== it || hw !== ao) { bad++;
      console.log(`  ${op} [${row.join(', ')}]\n      hw     ${hw}` +
        (it !== hw ? `\n      interp ${it}` : '') + (ao !== hw ? `\n      aot    ${ao}` : '')); }
  }
}
console.log(`\n${n - bad}/${n} float/integer conversion results match hardware in BOTH engines ` +
            `(${OPS.length} forms x ${ROWS.length} lane sets)`);
if (refused) console.log(`${refused} refused`);
if (bad || refused) process.exit(1);

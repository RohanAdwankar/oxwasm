// Differential: pmaddwd and cvtdq2ps, two lowerings wasm had exactly.
//
// pmaddwd multiplies signed 16-bit lanes and adds adjacent pairs into 32-bit
// lanes, wrapping. That is i32x4.dot_i16x8_s, instruction for instruction, and
// the emitter refused it anyway. cvtdq2ps is f32x4.convert_i32x4_s the same
// way. Both were reported as refusals by diff/fuzzaot.mjs once its generator
// learned the wide vector forms.
//
// This used to assert that the other two forms of 0F 5B stayed REFUSED, which
// was right while they were: x86 hands back 0x80000000 for a NaN or anything
// out of range, and wasm's trunc_sat does not. They are implemented now, from
// trunc_sat plus a per-lane range test, and diff/cvtintest.mjs checks them
// against hardware - so that assertion is gone rather than left to fail.
//
// Hardware is the oracle. The operand pairs are built for the multiply-add:
// both signs, both extremes, and products that overflow 32 bits so the
// wrapping is exercised rather than assumed.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, BUF = 0x420000n, SENT = 0xdeadbee0n;
const w = (...ws) => ws.reduce((a, v, i) => a | (BigInt(v & 0xFFFF) << BigInt(16 * i)), 0n);
const PAIRS = [
  // the extremes: -32768 * -32768 twice per lane overflows a signed 32-bit sum
  [w(0x8000,0x8000,0x8000,0x8000,0x7FFF,0x7FFF,0x7FFF,0x7FFF),
   w(0x8000,0x8000,0x7FFF,0x7FFF,0x8000,0x8000,0x7FFF,0x7FFF)],
  // mixed signs across the pair, so the two products cancel or reinforce
  [w(1,-1,2,-2,3,-3,4,-4), w(-1,1,-2,2,-3,3,-4,4)],
  [w(0,0,1,0,-1,0,0x7FFF,0), w(0x7FFF,0x7FFF,0,1,0,-1,0x8000,0)],
  // ordinary values, and values that as i32 span the float rounding boundary
  [w(100,200,300,400,500,600,700,800), w(9,8,7,6,5,4,3,2)],
  [0x7FFFFFFF80000000n | (0x00000001FFFFFFFFn << 64n), 0x0000000100000002n | (0x7FFFFFFF80000000n << 64n)],
  [0x8001F0F07FFF0001n | (0xFFFF8000A5A5C3C3n << 64n), 0x7FFF7FFF80008000n | (0x0001FFFF3C3C5A5An << 64n)],
];
const OPS = ['pmaddwd', 'cvtdq2ps'];
const hex = (v) => v.toString(16).padStart(32, '0');

let bad = 0, n = 0;
for (const op of OPS) {
  const body = `movdqu xmm0, [0x420000]\nmovdqu xmm1, [0x420020]\n${op} xmm0, xmm1\nmovdqu [0x420010], xmm0\nret`;
  writeFileSync('/tmp/dc.asm', 'BITS 64\n' + body);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/dc.bin', '/tmp/dc.asm']);
  const code = new Uint8Array(0x30000); code.set(readFileSync('/tmp/dc.bin'));
  let r = null;
  try { r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 }); }
  catch { r = null; }
  if (!r) { console.log(`  FAIL ${op} refused`); bad++; continue; }
  writeFileSync('/tmp/dc.wat', r.wat);
  execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/dc.wat', '-o', '/tmp/dc.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/dc.wasm'));

  for (const [A, B] of PAIRS) {
    const C = `int main(){unsigned char b[128] __attribute__((aligned(16)));
      unsigned long long*q=(unsigned long long*)b;
      q[0]=0x${(A & ((1n<<64n)-1n)).toString(16)}ULL; q[1]=0x${(A>>64n).toString(16)}ULL;
      q[4]=0x${(B & ((1n<<64n)-1n)).toString(16)}ULL; q[5]=0x${(B>>64n).toString(16)}ULL;
      asm volatile("movdqu %1,%%xmm0\\n\\tmovdqu %2,%%xmm1\\n\\t${op} %%xmm1,%%xmm0\\n\\tmovdqu %%xmm0,%0"
        :"=m"(b[16]):"m"(b[0]),"m"(b[32]):"xmm0","xmm1");
      for(int i=31;i>=16;i--) __builtin_printf("%02x", b[i]); __builtin_printf("\\n"); return 0;}`;
    writeFileSync('/tmp/dc.c', C);
    execFileSync('gcc', ['-O1', '-o', '/tmp/dcbin', '/tmp/dc.c']);
    const hw = execFileSync('/tmp/dcbin').toString().trim();

    const m = new Memory([{ base: CODE, bytes: code.slice() }]);
    m.write(BUF, 8n, A & ((1n<<64n)-1n)); m.write(BUF + 8n, 8n, A >> 64n);
    m.write(BUF + 0x20n, 8n, B & ((1n<<64n)-1n)); m.write(BUF + 0x28n, 8n, B >> 64n);
    const cpu = new CPU(m);
    for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
    cpu.regs[4] = CODE + 0x1000n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
    let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 50) throw new Error('runaway ' + op); }
    const it = hex((m.read(BUF + 0x18n, 8n) << 64n) | m.read(BUF + 0x10n, 8n));

    const mem = new WebAssembly.Memory({ initial: 4096 });
    const stub = () => { throw new Error('escape'); };
    const inst = new WebAssembly.Instance(mod, { js: { mem, ftab: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }) },
                                                 env: { syscall: stub, callout: stub, deopt: stub, loophot: stub, codewrite: stub } });
    const rv = new BigInt64Array(mem.buffer, 0, 16), dv = new DataView(mem.buffer);
    new Uint8Array(mem.buffer).set(code, 0);
    const off = Number(BUF - CODE);
    dv.setBigUint64(off, A & ((1n<<64n)-1n), true); dv.setBigUint64(off + 8, A >> 64n, true);
    dv.setBigUint64(off + 0x20, B & ((1n<<64n)-1n), true); dv.setBigUint64(off + 0x28, B >> 64n, true);
    for (let q = 0; q < 16; q++) rv[q] = 0n;
    rv[4] = BigInt.asIntN(64, CODE + 0x1000n);
    dv.setBigUint64(0x1000, SENT, true);
    inst.exports[r.entryName]();
    const ao = hex((dv.getBigUint64(off + 0x18, true) << 64n) | dv.getBigUint64(off + 0x10, true));

    n++;
    if (hw !== it || hw !== ao) { bad++;
      console.log(`  ${op} a=${hex(A)} b=${hex(B)}\n      hw     ${hw}` +
        (it !== hw ? `\n      interp ${it}` : '') + (ao !== hw ? `\n      aot    ${ao}` : '')); }
  }
}
console.log(`\n${n - bad}/${n} pmaddwd and cvtdq2ps results match hardware in BOTH engines ` +
            `(${PAIRS.length} operand pairs)`);
if (bad) process.exit(1);

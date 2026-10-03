// Differential: the packed double conversions of 0F E6, against hardware.
// cvtdq2pd (F3), cvttpd2dq (66), cvtpd2dq (F2) in the interpreter and the
// compiled tier. Edge values: exact ties both signs, the int32 boundary from
// both sides, NaN, infinities, signed zero.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, BUF = 0x420000n, SENT = 0xdeadbee0n;
const f64 = (x) => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, x, true); return b.getBigUint64(0, true); };
const ROWS = [
  [0.5, 1.5], [2.5, -0.5], [-1.5, -2.5], [3.49, -3.49],
  [2147483648, -2147483648], [2147483647.5, -2147483648.5], [2147483647, -2147483649],
  [1e30, -1e30], [NaN, Infinity], [-Infinity, 0], [-0, 1e-310], [0.49999999999999994, 4503599627370497.5],
];
const OPS = ['cvtdq2pd', 'cvttpd2dq', 'cvtpd2dq'];
const hex = (v) => v.toString(16).padStart(32, '0');
const M64 = (1n << 64n) - 1n;

let bad = 0, n = 0, refused = 0;
for (const op of OPS) {
  const body = `movdqu xmm0, [0x420000]\n${op} xmm0, xmm0\nmovdqu [0x420100], xmm0\nret`;
  writeFileSync('/tmp/cp.asm', 'BITS 64\n' + body);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/cp.bin', '/tmp/cp.asm']);
  const code = new Uint8Array(0x30000); code.set(readFileSync('/tmp/cp.bin'));
  let r;
  try { r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 }); }
  catch (e) { refused++; console.log(`  REFUSED ${op}: ${e.message.slice(0, 60)}`); continue; }
  writeFileSync('/tmp/cp.wat', r.wat);
  execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/cp.wat', '-o', '/tmp/cp.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/cp.wasm'));

  for (const row of ROWS) {
    // cvtdq2pd reads two integers: feed the row's values as int32
    const A = op === 'cvtdq2pd'
      ? row.reduce((a, x, i) => a | (BigInt.asUintN(32, BigInt(Math.trunc(Number.isFinite(x) ? Math.max(-2147483648, Math.min(2147483647, x)) : 0))) << BigInt(32 * i)), 0n)
      : row.reduce((a, x, i) => a | (f64(x) << BigInt(64 * i)), 0n);
    const C = `int main(){unsigned char b[300] __attribute__((aligned(16)));unsigned long long*q=(unsigned long long*)b;
      q[0]=0x${(A & M64).toString(16)}ULL; q[1]=0x${(A >> 64n).toString(16)}ULL;
      asm volatile("movdqu %1,%%xmm0\\n\\t${op} %%xmm0,%%xmm0\\n\\tmovdqu %%xmm0,%0":"=m"(b[256]):"m"(b[0]):"xmm0");
      for(int i=271;i>=256;i--) __builtin_printf("%02x", b[i]); __builtin_printf("\\n"); return 0;}`;
    writeFileSync('/tmp/cp.c', C);
    execFileSync('gcc', ['-O1', '-o', '/tmp/cpbin', '/tmp/cp.c']);
    const hw = execFileSync('/tmp/cpbin').toString().trim();

    const m = new Memory([{ base: CODE, bytes: code.slice() }]);
    m.write(BUF, 8n, A & M64); m.write(BUF + 8n, 8n, A >> 64n);
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
    dv.setBigUint64(off, A & M64, true); dv.setBigUint64(off + 8, A >> 64n, true);
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
console.log(`\n${n - bad}/${n} packed-double conversion results match hardware in BOTH engines (${OPS.length} forms x ${ROWS.length} lane sets)`);
if (refused) console.log(`${refused} refused`);
if (bad || refused) process.exit(1);

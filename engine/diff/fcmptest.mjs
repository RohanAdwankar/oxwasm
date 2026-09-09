// Differential test: ucomiss/ucomisd flag production in the AOT tier.
// glibc's pow does `ucomisd; ja` on its fast/slow-path decision — the one
// unsupported op that pinned the whole libm phase of GIMP's startup to the
// interpreter. ZF/PF/CF only; NaN makes all three 1; OF/SF cleared.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, SENT = 0xdeadbee0n, SCRATCH = 0x410000n;
const f64 = (x) => { const b = new ArrayBuffer(8); new DataView(b).setFloat64(0, x, true); return new DataView(b).getBigUint64(0, true); };
const f32 = (x) => { const b = new ArrayBuffer(4); new DataView(b).setFloat32(0, x, true); return BigInt(new DataView(b).getUint32(0, true)); };
const PAIRS = [[1.5, 2.5], [2.5, 1.5], [3.25, 3.25], [NaN, 1.0], [1.0, NaN], [0.0, -0.0], [-1e300, 1e-300], [Infinity, 1.0]];

let pass = 0, fail = 0;
for (const [op, mem] of [['ucomisd', 0], ['ucomisd', 1], ['ucomiss', 0], ['ucomiss', 1], ['comisd', 0], ['comiss', 0]]) {
  const wide = op.endsWith('d');
  const body = mem
    ? `mov rsi, 0x410000\n${op} xmm0, [rsi]`
    : `${op} xmm0, xmm1`;
  const asm = `BITS 64
${body}
seta al
setae bl
setb cl
setbe dl
sete sil
setne dil
setp r8b
setnp r9b
adc r10, r11
ret`;
  writeFileSync('/tmp/fc.asm', asm);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/fc.bin', '/tmp/fc.asm']);
  const bin = readFileSync('/tmp/fc.bin'); const code = new Uint8Array(0x20000); code.set(bin);
  let r;
  try { r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 }); }
  catch (e) { console.log(`SKIP ${op} mem=${mem}: ${e.message}`); fail++; continue; }
  writeFileSync('/tmp/fc.wat', r.wat); execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/fc.wat', '-o', '/tmp/fc.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/fc.wasm'));
  for (const [x, y] of PAIRS) {
    const xb = wide ? f64(x) : f32(x), yb = wide ? f64(y) : f32(y);
    const m = new Memory([{ base: CODE, bytes: code.slice() }]);
    const cpu = new CPU(m);
    for (let i = 0; i < 16; i++) cpu.regs[i] = 0n;
    cpu.xmm[0] = xb; cpu.xmm[1] = yb;
    m.write(SCRATCH, 8n, wide ? yb : yb);
    cpu.regs[4] = CODE + 0x800n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
    let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 60) throw new Error('runaway'); }
    const want = [0,3,1,2,6,7,8,9,10].map(i => BigInt.asUintN(64, cpu.regs[i]));

    const wmem = new WebAssembly.Memory({ initial: 4096 });
    const stub = () => { throw new Error('escape'); };
    const inst = new WebAssembly.Instance(mod, { js: { mem: wmem, ftab: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }) }, env: { syscall: stub, callout: stub, deopt: stub, loophot: stub, codewrite: stub } });
    const rv = new BigInt64Array(wmem.buffer, 0, 16);
    const xvv = new BigInt64Array(wmem.buffer, 256, 32);
    for (let i = 0; i < 16; i++) rv[i] = 0n;
    xvv[0] = BigInt.asIntN(64, xb); xvv[1] = 0n;
    xvv[2] = BigInt.asIntN(64, yb); xvv[3] = 0n;
    rv[4] = BigInt.asIntN(64, CODE + 0x800n);
    const dv = new DataView(wmem.buffer);
    dv.setBigUint64(0x800, SENT, true);
    dv.setBigUint64(0x10000, yb, true);
    inst.exports[r.entryName]();
    const got = [0,3,1,2,6,7,8,9,10].map(i => BigInt.asUintN(64, rv[i]));
    if (got.every((v, i) => v === want[i])) pass++;
    else { fail++;
      if (fail <= 6) console.log(`MISMATCH ${op} mem=${mem} ${x} vs ${y}: interp=${want.join(',')} aot=${got.join(',')}`); }
  }
}
console.log(`\n${pass}/${pass + fail} ucomis/comis flag results bit-exact (AOT vs interpreter)`);
if (fail) process.exit(1);

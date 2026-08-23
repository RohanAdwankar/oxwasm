import { readFileSync } from 'node:fs';
const sw = +process.argv[2] || 2048, dw = +process.argv[3] || 8192;
const srcB = sw*sw*4, midB = dw*sw*16, dstB = dw*dw*4, tabB = Math.max(dw,sw)*16;
const HEAP = 1 << 20;
const need = HEAP + srcB + midB + dstB + tabB*2 + (1<<20);
const mod = await WebAssembly.compile(readFileSync('resample-relaxed.wasm'));
const inst = await WebAssembly.instantiate(mod, {});
const mem = inst.exports.memory;
const have = mem.buffer.byteLength;
if (need > have) mem.grow(Math.ceil((need - have) / 65536) + 4);
const srcOff = HEAP, midOff = srcOff + srcB, dstOff = midOff + midB,
      tapsOff = dstOff + dstB, wtsOff = tapsOff + tabB;
inst.exports.fill(srcOff, sw, sw);
for (let i = 0; i < 25; i++) inst.exports.resample(srcOff, 64, 64, dstOff, 128, 128, midOff, tapsOff, wtsOff); // heat until TurboFan tiers
let best = 1e18;
for (let rep = 0; rep < 4; rep++) {
  const t = process.hrtime.bigint();
  inst.exports.resample(srcOff, sw, sw, dstOff, dw, dw, midOff, tapsOff, wtsOff);
  const s0 = Number(process.hrtime.bigint() - t) / 1e9;
  if (s0 < best) best = s0;
}
const s = best;
const ck = (inst.exports.checksum(dstOff, dstB) >>> 0).toString(16).padStart(8, '0');
console.log(`wasm   ${sw}x${sw} -> ${dw}x${dw}: ${s.toFixed(3)} s  checksum=${ck}`);

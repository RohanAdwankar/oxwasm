import { readFileSync } from 'node:fs';
const STEPS = 100_000_000;
for (const v of ['full', 'min', 'params', 'sw']) {
  const { instance } = await WebAssembly.instantiate(readFileSync(new URL('./' + v + '.wasm', import.meta.url)));
  const mem = new DataView(instance.exports.mem.buffer);
  const u8 = new Uint8Array(instance.exports.mem.buffer);
  let x = 12345; const pat = []; for (let i = 0; i < 24; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; pat.push(1 + ((x >>> 16) % 63)); } for (let i = 0; i < 4096; i++) u8[1048576 + i] = pat[i % 24];
  for (let k = 0; k < 64; k++) { const h = (Math.imul(k, 0x9E3779B1) >>> 17) << 4; let p = 393216 + h; while (mem.getBigUint64(p, true) !== 0n) p = 393216 + (((p - 393216) + 16) & 524287); mem.setBigUint64(p, BigInt(k), true); mem.setUint32(p + 8, k, true); }
  // key 0 collides with the empty marker: give handler 0 a nonzero id by never selecting it (stream uses 1..63)
  for (let i = 0; i < 4096; i++) if (u8[1048576 + i] === 0) u8[1048576 + i] = 1;
  mem.setUint32(65548, STEPS, true); mem.setUint32(65544, 0, true); mem.setUint32(65556, 0, true);
  for (let r = 0; r < 3; r++) {
    for (let k = 0; k < 5; k++) mem.setBigUint64(k * 8, k === 4 ? 1n : 0n, true);
    mem.setUint32(65548, STEPS, true); mem.setUint32(65544, 0, true);
    const t = performance.now(); const out = instance.exports.run(); const dt = performance.now() - t;
    console.log(v, 'run', r, (dt | 0) + ' ms', ((dt * 1e6 / STEPS).toFixed(2)) + ' ns/dispatch', 'out', out);
  }
}

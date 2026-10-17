import { readFileSync } from 'node:fs';
const STEPS = 50_000_000;
const t0 = performance.now();
const { instance } = await WebAssembly.instantiate(readFileSync('big.wasm'));
const ct = performance.now() - t0;
const u8 = new Uint8Array(instance.exports.mem.buffer); let x = 12345; const pat = [];
for (let i = 0; i < 24; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; pat.push((x >>> 16) % 251); }
for (let i = 0; i < 4096; i++) u8[1048576 + i] = pat[i % 24];
for (let r = 0; r < 2; r++) { const t = performance.now(); instance.exports.run(); const dt = performance.now() - t; console.log('compile', ct | 0, 'ms; run', (dt | 0) + ' ms', (dt * 1e6 / STEPS).toFixed(2) + ' ns/dispatch'); }

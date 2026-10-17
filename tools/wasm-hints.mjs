// Add a V8 "compilationHints" custom section to a wasm module (needs --experimental-wasm-compilation-hints).
//   node tools/wasm-hints.mjs in.wasm out.wasm [minBodyBytes=20000]
// Functions with a body of at least minBodyBytes are marked eager + optimized (TurboFan from the start, no Liftoff stage);
// all others keep V8's default tiering. One byte per defined function: bits 0-1 strategy (0 default, 2 eager),
// bits 2-3 baseline tier (2 optimized), bits 4-5 top tier (2 optimized). The section must precede the code section.
import { readFileSync, writeFileSync } from 'node:fs';
const uleb = (n) => { const o = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; o.push(x); } while (n); return o; };
export function addHints(bytes, minBody = 20000) {
  const secs = []; let p = 8;
  const rd = () => { let r = 0, s = 0, x; do { x = bytes[p++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return r >>> 0; };
  while (p < bytes.length) { const start = p, id = bytes[p++], size = rd(), body = p; p += size; secs.push({ id, start, body, end: p }); }
  const code = secs.find((s) => s.id === 10); if (!code) throw new Error('no code section');
  // function bodies: count, then (size, body)*
  let q = code.body; const rd2 = () => { let r = 0, s = 0, x; do { x = bytes[q++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return r >>> 0; };
  const n = rd2(); const hints = [];
  for (let i = 0; i < n; i++) { const sz = rd2(); hints.push(sz >= minBody ? (2 | (2 << 2) | (2 << 4)) : 0); q += sz; }
  const name = new TextEncoder().encode('compilationHints');
  const payload = [...uleb(name.length), ...name, ...uleb(n), ...hints];
  const sec = Uint8Array.from([0, ...uleb(payload.length), ...payload]);
  const out = new Uint8Array(bytes.length + sec.length);
  out.set(bytes.subarray(0, code.start), 0); out.set(sec, code.start); out.set(bytes.subarray(code.start), code.start + sec.length);
  return { bytes: out, functions: n, marked: hints.filter(Boolean).length };
}
if (process.argv[1] && process.argv[1].endsWith('wasm-hints.mjs')) {
  const [inp, outp, min] = process.argv.slice(2);
  const r = addHints(new Uint8Array(readFileSync(inp)), +min || 20000);
  writeFileSync(outp, r.bytes); console.log(`${r.functions} functions, ${r.marked} marked eager+optimized`);
}

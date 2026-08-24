import { readFileSync } from 'node:fs';
const wasm = new Uint8Array(readFileSync('md5-fromsrc.wasm'));
const inst = (await WebAssembly.instantiate(wasm, {})).instance;
const mem = inst.exports.memory; const u8 = new Uint8Array(mem.buffer);
const data = new Uint8Array(readFileSync(process.argv[2]));
const n = data.length; let total = n + 1 + 8; total += (64 - total % 64) % 64;
const HEAP = 8<<20, stOff = HEAP, bufOff = HEAP + 64;
if (mem.buffer.byteLength < bufOff + total + 65536) mem.grow(Math.ceil((bufOff+total)/65536)+4);
const u = new Uint8Array(mem.buffer);
u.set(data, bufOff); u[bufOff+n] = 0x80;
new DataView(mem.buffer).setBigUint64(bufOff + total - 8, BigInt(n)*8n, true);
const iv = [0x67452301,0xefcdab89,0x98badcfe,0x10325476];
const dv = new DataView(mem.buffer);
let best = 1e18, digest;
for (let i = 0; i < 8; i++) {
  for (let k=0;k<4;k++) dv.setUint32(stOff + k*4, iv[k], true);
  const t = process.hrtime.bigint(); inst.exports.md5_blocks(stOff, bufOff, BigInt(total/64)); const ns = Number(process.hrtime.bigint()-t);
  if (ns < best) best = ns;
  digest = [...new Uint8Array(mem.buffer, stOff, 16)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
console.log(`from-source wasm md5_blocks: ${(best/1e6).toFixed(1)} ms   digest ${digest}`);

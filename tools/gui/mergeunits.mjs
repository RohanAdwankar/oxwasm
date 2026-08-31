// Merge captured translation units into a shipped app.units.gz.
//
// replay.mjs CAPTURE=... records the units the engine compiles while driving
// the interactive path, in the same container shape as app.units.gz (u32
// index length, JSON [[name, off, len], ...], then bodies). The shipped
// manifest is whatever the packer happened to reach, which is startup plus
// whatever the packing run touched - not the paint/menu path a user drives.
// This folds a capture back in so the shipped artifact starts with those
// units already present.
//
//   node tools/gui/mergeunits.mjs demo/gimp /tmp/extra3.units
//
// A unit already in the manifest is kept as it is: same rip, same input
// bytes, same emitter, so the two agree, and preferring the shipped copy
// keeps the merge a pure addition. Verify by replaying the repacked
// directory and checking it matches the EXTRA= run it came from.
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

const [DIR, EXTRA] = process.argv.slice(2);
if (!DIR || !EXTRA) { console.error('usage: mergeunits.mjs <dir> <captured.units>'); process.exit(2); }

const container = (buf) => {
  const n = buf.readUInt32LE(0);
  const idx = JSON.parse(buf.toString('utf8', 4, 4 + n));
  const base = 4 + n, out = new Map();
  for (const [name, off, len] of idx) out.set(name, buf.subarray(base + off, base + off + len));
  return out;
};
const write = (units) => {
  const idx = [], parts = []; let off = 0;
  for (const [name, buf] of units) { idx.push([name, off, buf.length]); off += buf.length; parts.push(Buffer.from(buf)); }
  const ib = Buffer.from(JSON.stringify(idx));
  const hdr = Buffer.alloc(4); hdr.writeUInt32LE(ib.length, 0);
  return Buffer.concat([hdr, ib, ...parts]);
};

const path = `${DIR}/app.units.gz`;
const have = container(gunzipSync(readFileSync(path)));
const add = container(readFileSync(EXTRA));

let added = 0, dup = 0;
for (const [name, buf] of add) { if (have.has(name)) dup++; else { have.set(name, buf); added++; } }

const raw = write(have);
const gz = gzipSync(raw, { level: 9 });
writeFileSync(path, gz);
console.log(`units ${have.size - added} -> ${have.size} (+${added} new, ${dup} already present)`);
console.log(`${path}: ${gz.length} bytes gzipped, ${raw.length} raw`);
console.log(`set CFG.sizes.units to ${raw.length} in ${DIR}/index.html`);

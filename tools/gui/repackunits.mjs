// Recompile every unit in a shipped app.units.gz from the snapshot memory.
//
// The shipped containers were captured before hot-callee inlining and the
// inlined dispatch probe were default-on, and mergeunits only ADDS units, so
// a flip in the emitter never reaches ship without this: restore the packed
// snapshot exactly the way replay.mjs does (state + rom file set + mem tiles
// + fills), then re-run compileUnitWat at each container entry, in index
// order, with the same closure pruning shape the live engine uses (skip
// functions already emitted by an earlier unit). The memory image is the one
// the units were originally compiled from, so decode is identical and the
// only change is what the emitter now emits.
//
//   node tools/gui/repackunits.mjs [demo/gimp] [-o out.units.gz]
//
// A unit that fails to recompile keeps its OLD bytes (counted and named), so
// the output is never worse than the input. Writes next to the input only
// with -o; never overwrites app.units.gz itself.
import { LinuxEngine } from '../../engine/linux.mjs';
import { XServer } from '../../engine/xserver.mjs';
import { CPU } from '../../engine/interp.mjs';
import { restoreEngineCore } from '../../engine/snapshot_core.mjs';
import { parsePCF } from '../../engine/pcf.mjs';
import { compileUnitWat } from '../../engine/aot_wat.mjs';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';

const DIR = process.argv[2] || 'demo/gimp';
const oi = process.argv.indexOf('-o');
const OUT = oi > 0 ? process.argv[oi + 1] : `${DIR}/app.units.new.gz`;

const container = (buf) => {
  const n = buf.readUInt32LE(0);
  const idx = JSON.parse(buf.toString('utf8', 4, 4 + n));
  const base = 4 + n, out = new Map();
  for (const [name, off, len] of idx) out.set(name, buf.subarray(base + off, base + off + len));
  return out;
};
const writeContainer = (units) => {
  const idx = []; let off = 0; const parts = [];
  for (const [name, buf] of units) { idx.push([name, off, buf.length]); off += buf.length; parts.push(Buffer.from(buf)); }
  const j = Buffer.from(JSON.stringify(idx));
  const head = Buffer.alloc(4); head.writeUInt32LE(j.length, 0);
  return Buffer.concat([head, j, ...parts]);
};
const gz = (p) => gunzipSync(readFileSync(`${DIR}/${p}`));
const maybe = (b) => { try { return new Uint8Array(gunzipSync(b)); } catch { return new Uint8Array(b); } };

// ---- restore, exactly the replay.mjs shape --------------------------------
const state = container(gz('app.state.gz'));
const files = {}, fonts = {};
for (const [k, v] of state) {
  if (k.startsWith('file:')) files[k.slice(5)] = maybe(v);
  else if (k.startsWith('font:')) { try { fonts[k.slice(5)] = parsePCF(maybe(v)); } catch {} }
}
try { for (const [k, v] of container(gz('app.rom.gz')))
        if (k.startsWith('file:') && !files[k.slice(5)]) files[k.slice(5)] = maybe(v); }
catch {}
const elf = files['/usr/bin/gimp'];
if (!elf) { console.log('no /usr/bin/gimp in the state container'); process.exit(1); }
const json = Buffer.from(maybe(state.get('json'))), blobs = maybe(state.get('blobs'));
const snap = JSON.parse(json.toString('utf8'));
const root = (snap.x?.res || []).find(w => w.parent === null) || { w: 1024, h: 768 };
const xs = new XServer({ width: root.w, height: root.h, fonts });
const eng = new LinuxEngine(elf, {
  argv: ['/usr/bin/gimp'],
  env: ['DISPLAY=:0', 'HOME=/root', 'USER=root',
        'LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu:/lib/x86_64-linux-gnu'],
  files, mtimes: {}, memMB: Math.round(Number(snap.memLen) / (1 << 20)) - 2, xserver: xs });
await restoreEngineCore(eng, xs,
  { json: json.toString('utf8'), blobs, mem: new Uint8Array(gz('app.mem.gz')) },
  CPU, (b) => maybe(b));
{
  const all = new Uint8Array(eng.wmem.buffer);
  let filled = 0;
  const fillsRaw = state.get('fills');
  for (const [path, , runs] of (fillsRaw ? JSON.parse(Buffer.from(maybe(fillsRaw)).toString('utf8')) : [])) {
    const fb = files[path]; if (!fb) continue;
    for (const [wOff, fOff, rlen] of runs) {
      const n = Math.max(0, Math.min(rlen, fb.length - fOff));
      if (n > 0) { all.set(fb.subarray(fOff, fOff + n), wOff); filled += n; }
    }
  }
  console.log(`restored; fills replayed ${(filled / 1048576).toFixed(1)} MB`);
}

// ---- recompile every unit in index order ----------------------------------
const old = container(gz('app.units.gz'));
let an = 0;
const assemble = (wat) => {
  const w = `/tmp/rpk_${process.pid}_${an++ % 4}`;
  writeFileSync(w + '.wat', wat);
  execFileSync('wat2wasm', ['--enable-tail-call', w + '.wat', '-o', w + '.wasm']);
  const b = new Uint8Array(readFileSync(w + '.wasm'));
  try { unlinkSync(w + '.wat'); unlinkSync(w + '.wasm'); } catch {}
  return b;
};
const seen = new Set();          // the live engine's _ftSeen shape, in ship order
const out = new Map();
let ok = 0, failed = 0, oldBytes = 0, newBytes = 0;
const failures = [];
const t0 = Date.now();
for (const [name, bytes] of old) {
  oldBytes += bytes.length;
  const entry = BigInt('0x' + name);
  try {
    const unit = compileUnitWat(eng.mem, entry, {
      guestBase: eng.base, ramBase: eng.RAMOFF,
      skip: (c) => seen.has(BigInt(c).toString()),
      hot: eng.aotCalls });
    const nb = assemble(unit.wat);
    for (const a of unit.funcs) seen.add(BigInt(a).toString());
    out.set(name, nb); newBytes += nb.length; ok++;
  } catch (e) {
    out.set(name, new Uint8Array(bytes)); newBytes += bytes.length; failed++;
    if (failures.length < 10) failures.push(`${name}: ${String(e.message || e).slice(0, 100)}`);
    seen.add(entry.toString());
  }
  if ((ok + failed) % 500 === 0)
    console.log(`  ${ok + failed}/${old.size} units, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
const packed = gzipSync(writeContainer(out), { level: 9 });
writeFileSync(OUT, packed);
console.log(`\n${ok} recompiled, ${failed} kept old bytes${failures.length ? ':' : ''}`);
for (const f of failures) console.log('  ' + f);
console.log(`raw ${(oldBytes / 1048576).toFixed(1)} -> ${(newBytes / 1048576).toFixed(1)} MB, ` +
            `container ${packed.length} bytes gz -> ${OUT}`);
console.log(`page needs CFG.sizes.units = ${packed.length} if this ships as app.units.gz`);
process.exit(0);

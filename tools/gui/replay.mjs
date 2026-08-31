// Drive the SHIPPED artifact and measure first-vs-Nth interaction latency.
//
// "Nth-interaction latency" is a stated requirement and had never been
// measured, because the node restore path wants the pre-pack snapshot
// (.json/.blobs/.mem) and the repo ships the packed page instead. But
// demo/gimp/app.state.gz unpacks in node and contains exactly those sections,
// so the real product can be driven here rather than rebuilt from a sysroot.
//
//   node tools/gui/replay.mjs [demo/gimp] [interactions]
import { LinuxEngine } from '../../engine/linux.mjs';
import { XServer } from '../../engine/xserver.mjs';
import { CPU } from '../../engine/interp.mjs';
import { restoreEngineCore } from '../../engine/snapshot_core.mjs';
import { parsePCF } from '../../engine/pcf.mjs';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const DIR = process.argv[2] || 'demo/gimp';
const N = Number(process.argv[3] || 6);

const container = (buf) => {
  const n = buf.readUInt32LE(0);
  const idx = JSON.parse(buf.toString('utf8', 4, 4 + n));
  const base = 4 + n, out = new Map();
  for (const [name, off, len] of idx) out.set(name, buf.subarray(base + off, base + off + len));
  return out;
};
const gz = (p) => gunzipSync(readFileSync(`${DIR}/${p}`));
// Sections inside the packed container are individually compressed in some
// builds and raw in others; the page knows which because it wrote them. Here,
// try to inflate and fall back to the bytes as they are.
const maybe = (b) => { try { return new Uint8Array(gunzipSync(b)); } catch { return new Uint8Array(b); } };

const state = container(gz('app.state.gz'));
const files = {}, fonts = {};
for (const [k, v] of state) {
  if (k.startsWith('file:')) files[k.slice(5)] = maybe(v);
  else if (k.startsWith('font:')) { try { fonts[k.slice(5)] = parsePCF(maybe(v)); } catch {} }
}
const elf = files['/usr/bin/gimp'];
if (!elf) { console.log('no /usr/bin/gimp in the state container'); process.exit(1); }

const json = Buffer.from(maybe(state.get('json'))), blobs = maybe(state.get('blobs'));
const snap = JSON.parse(json.toString('utf8'));
const memLen = snap.memLen;
// the framebuffer is sized by the ROOT window in the snapshot, not by a
// guess: restore writes the saved fb straight into xs.fb and a mismatch is an
// out-of-bounds set rather than a resize
const root = (snap.x?.res || []).find(w => w.parent === null) || { w: 1024, h: 768 };
const xs = new XServer({ width: root.w, height: root.h, fonts });
const eng = new LinuxEngine(elf, {
  argv: ['/usr/bin/gimp'],
  env: ['DISPLAY=:0', 'HOME=/root', 'USER=root',
        'LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu:/lib/x86_64-linux-gnu'],
  // the engine allocates memMB plus its own two reserved megabytes, so the
  // snapshot's memLen is memMB + 2 - solve for it rather than guessing
  files, mtimes: {}, memMB: Math.round(Number(memLen) / (1 << 20)) - 2, xserver: xs });

await restoreEngineCore(eng, xs,
  { json: json.toString('utf8'), blobs, mem: new Uint8Array(gz('app.mem.gz')) },
  CPU, (b) => maybe(b));

// every captured unit, registered the way the page does it
let units = 0, fns = 0;
for (const [, bytes] of container(gz('app.units.gz'))) {
  try {
    const { instance } = await WebAssembly.instantiate(new Uint8Array(bytes), eng.aotImports());
    for (const name of Object.keys(instance.exports))
      if (name.startsWith('f_')) {
        const a = BigInt('0x' + name.slice(2));
        if (!eng.aotFns.get(a)) { eng.registerAotFn(a, instance.exports[name]); fns++; }
      }
    units++;
  } catch {}
}
console.log(`restored: ${units} units, ${fns} functions mapped, ftFull=${eng._ftFull || 0}`);

// INCOMPLETE: the page does not restore memory from app.mem alone. It passes
// mem: null, streams app.rom (library text, kept out of the snapshot so the
// page can start before it lands) into the wasm memory, and then replays the
// `fills` section, which reconstructs regions from the guest FILES rather than
// storing them twice. Without those two steps the guest resumes with library
// pages missing and faults on the first call into one - `fault: ca` here.
//
// Next: apply container(gz('app.rom.gz')) into eng.wmem at each section's
// offset, then walk state.get('fills') as [path, _, runs] and copy
// files[path][fOff..] to wasm offset wOff, exactly as xpack.mjs:1170 does.

const pump = (ms) => {                      // run until idle or the budget is spent
  const t0 = process.hrtime.bigint();
  while (Number(process.hrtime.bigint() - t0) / 1e6 < ms) {
    const before = eng.stats.interpreted + eng.stats.aotRuns;
    eng.run(2e6);
    if (eng.blocked) eng.wake();
    if (eng.stats.interpreted + eng.stats.aotRuns === before) break;   // quiescent
  }
};
pump(3000);                                  // settle after restore

// The same interaction N times. If the first is slower than the rest by more
// than the run-to-run spread, the tiering policy is the reason and #31 is real.
console.log('\n  n     ms   interp     aot   painted');
const rows = [];
for (let i = 0; i < N; i++) {
  const i0 = eng.stats.interpreted, a0 = eng.stats.aotRuns;
  const t0 = process.hrtime.bigint();
  xs.injectMotion(420, 30); xs.injectButton(1, true);
  pump(1500);
  xs.injectButton(1, false);
  pump(1500);
  xs.injectMotion(420, 300);                 // close whatever opened
  xs.injectButton(1, true); xs.injectButton(1, false);
  pump(1500);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const interp = eng.stats.interpreted - i0, aot = eng.stats.aotRuns - a0;
  let painted = 0;
  try { const fb = xs.flush(); const bg = fb[0]; for (let p = 0; p < fb.length; p += 997) if (fb[p] !== bg) painted++; } catch {}
  rows.push({ ms, interp, aot });
  console.log(`  ${i}  ${ms.toFixed(0).padStart(5)}  ${String(interp).padStart(8)}  ${String(aot).padStart(6)}  ${painted}`);
}
const rest = rows.slice(1);
if (rest.length) {
  const med = [...rest].sort((a, b) => a.ms - b.ms)[rest.length >> 1];
  const spread = (Math.max(...rest.map(r => r.ms)) - Math.min(...rest.map(r => r.ms))) / med.ms * 100;
  console.log(`\nfirst ${rows[0].ms.toFixed(0)}ms vs median-of-rest ${med.ms.toFixed(0)}ms ` +
              `(${(rows[0].ms / med.ms).toFixed(2)}x), spread of the rest +/-${spread.toFixed(0)}%`);
  console.log(`first interp ${rows[0].interp} vs median-of-rest ${med.interp}`);
}

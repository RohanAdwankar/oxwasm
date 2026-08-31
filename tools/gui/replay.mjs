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
// app.rom carries the guest files the packer deduped OUT of the state
// container - it is a file set, not a memory image (xpack.mjs:987 merges it
// into `files` exactly like this). Without it the fills below have nothing to
// reconstruct library pages from.
let romFiles = 0;
try { for (const [k, v] of container(gz('app.rom.gz')))
        if (k.startsWith('file:') && !files[k.slice(5)]) { files[k.slice(5)] = maybe(v); romFiles++; } }
catch (e) { console.log('no rom sidecar:', e.message); }

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

// `fills`: the packer stores library pages ONCE, in the guest file, and
// records where they belong in memory instead of writing them twice. Replaying
// them is what puts library text back into the wasm memory after the snapshot
// tiles land - skip it and the guest resumes with holes and faults on its
// first call into one.
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
  console.log(`rom files ${romFiles}, fills replayed ${(filled / 1048576).toFixed(1)} MB`);
}

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
console.log(`  rip 0x${eng.cpu.rip.toString(16)} rsp 0x${eng.cpu.regs[4].toString(16)} ` +
            `threads ${eng.threads.length} ti ${eng.ti} states ${eng.threads.map(t=>t.state).join(',')} ` +
            `blocked ${!!eng.blocked} exit ${eng.exitCode}`);

// RESTORE IS COMPLETE: rom file set merged, 212MB of fills replayed, all four
// guest threads land with the rips the snapshot recorded.
//
// WHAT IS LEFT is the pump, and it is a real difference from the single-
// threaded harnesses. `if (eng.blocked) eng.wake()` is what xshot does and is
// correct there, but this guest has four threads blocked on their own
// conditions (futexes, poll on the X connection). Waking all of them resumes
// threads whose condition was never satisfied, and one of them runs off into
// rip 0 - a guest crash this harness caused, not one the engine has.
//
// Next: wake only when there is a reason to - after injecting input, or when
// a thread's deadline has passed - the way the page's pump() does, rather
// than unconditionally on every blocked slice.

const pump = (ms) => {                      // run until idle or the budget is spent
  const t0 = process.hrtime.bigint();
  while (Number(process.hrtime.bigint() - t0) / 1e6 < ms) {
    const before = eng.stats.interpreted + eng.stats.aotRuns;
    try { eng.run(2e6); }
    catch (e) {
      console.log(`  guest fault: ${e.message} rip 0x${eng.cpu.rip.toString(16)} ` +
                  `ti ${eng.ti} states ${eng.threads.map(t => t.state).join(',')} ` +
                  `rips ${eng.threads.map(t => '0x' + t.cpu.rip.toString(16)).join(',')}`);
      throw e;
    }
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

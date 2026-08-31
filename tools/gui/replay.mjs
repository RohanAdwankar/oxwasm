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
import { decode } from '../../engine/decode.mjs';
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
// Decode at each parked rip. The engine's contract is that a blocking
// syscall RE-EXECUTES on resume, which only holds if the saved rip points AT
// the syscall instruction rather than past it.
console.log('  per-thread rips at restore:');
for (const [i, t] of eng.threads.entries()) {
  let at = '?', before = '?';
  try { at = decode((k) => Number(eng.mem.read(t.cpu.rip + BigInt(k), 1n)), t.cpu.rip).mnem; } catch (e) { at = 'undecodable'; }
  // a syscall is 0f 05: if the rip is one instruction PAST it, the two bytes
  // immediately before the rip are exactly that
  try { const p = Number(eng.mem.read(t.cpu.rip - 2n, 2n)); before = p === 0x050f ? 'PRECEDED BY syscall' : ''; } catch {}
  console.log(`    ${i} ${t.state.padEnd(4)} 0x${t.cpu.rip.toString(16)}  at=${at} ${before}`);
}
// Is each parked thread's STACK actually there? The rips and states matching
// the snapshot says nothing about anonymous memory: fills reconstruct
// file-backed pages, and a thread stack is anonymous, so it can only come from
// the app.mem tiles. A ret that returns to 0 is what a zeroed stack looks
// like.
for (const [i, t] of eng.threads.entries()) {
  const sp = t.cpu.regs[4];
  let words = [];
  for (let k = 0; k < 6; k++) { try { words.push(eng.mem.read(sp + BigInt(k * 8), 8n).toString(16)); } catch { words.push('unmapped'); } }
  console.log(`    t${i} rsp 0x${sp.toString(16)} stack: ${words.join(' ')}`);
}
console.log(`  rip 0x${eng.cpu.rip.toString(16)} rsp 0x${eng.cpu.regs[4].toString(16)} ` +
            `threads ${eng.threads.length} ti ${eng.ti} states ${eng.threads.map(t=>t.state).join(',')} ` +
            `blocked ${!!eng.blocked} exit ${eng.exitCode}`);

// RESTORE IS COMPLETE: rom file set merged, 212MB of fills replayed, all four
// guest threads land with the rips the snapshot recorded.
//
// WHAT IS LEFT is RESUME, and the pump was not it. Waking only for a reason
// (input delivered, or an expired deadline) and dropping the settle pump
// entirely both leave the same crash: a thread resumes and runs off into
// rip 0. So this is not "the harness woke a thread that had no business
// waking" - it is that resuming these parked threads at all goes wrong here
// while it works in the page.
//
// The sharp next question, and it is one decode away from an answer: every
// thread is parked inside a blocking syscall, and the engine's contract is
// that such a syscall RE-EXECUTES on resume ("every blocking syscall
// re-executes and re-checks its condition"). That only holds if the saved rip
// points AT the syscall instruction rather than after it. Decode at the
// restored rips - 0xa348bf7 for threads 0 and 1, 0xa34f837 for thread 3 - and
// see which. If they point past the syscall, resume re-enters the guest one
// instruction late with the syscall's return value never written, which is
// exactly the shape of a thread that then walks off into rip 0.

// Every parked rip decodes as `syscall`, so the resume contract holds and the
// saved-rip hypothesis is dead. What the syscalls RETURN on re-execution is
// the next suspect: a guest whose X connection reads EOF concludes the display
// died and takes itself apart. Log the tail so the fault can name its cause.
const trail = [], rips = [];
{
  const inner = eng.syscall.bind(eng);
  eng.syscall = (cpu) => {
    const nr = cpu.regs[0], t = eng.ti;
    const r = inner(cpu);
    if (trail.length > 40) trail.shift();
    trail.push(`t${t} nr=${nr} -> ${BigInt.asIntN(64, cpu.regs[0])}`);
    return r;
  };
}

// Wake for a REASON. Unconditional wake() is right for a single-threaded
// guest (xshot does it) and wrong here: GIMP has four threads parked on their
// own futexes and X-connection polls, and resuming one whose condition was
// never satisfied sends it off into rip 0. So: wake once when input has just
// been delivered, wake when a thread's own deadline has expired, and otherwise
// let a blocked engine stay blocked.
const pump = (ms, kick = false) => {
  const t0 = process.hrtime.bigint();
  if (kick) eng.wake();                       // input landed: the poll has a result now
  while (Number(process.hrtime.bigint() - t0) / 1e6 < ms) {
    const before = eng.stats.interpreted + eng.stats.aotRuns;
    // TRACE=1 steps one instruction at a time and keeps the last rips, so the
    // instruction that jumps to zero can be named instead of guessed at. The
    // syscall trail already narrowed it to "right after futex returns EAGAIN".
    try { if (process.env.TRACE) { for (let k = 0; k < 2e6; k++) {
            rips.push(`t${eng.ti}:0x${eng.cpu.rip.toString(16)}`);
            if (rips.length > 60) rips.shift();
            eng.run(1);
            if (eng.blocked || eng.exitCode !== null) break;
          } } else eng.run(2e6); }
    catch (e) {
      console.log('  last syscalls: ' + trail.slice(-16).join(' | '));
      if (rips.length) console.log('  last rips: ' + rips.slice(-30).join(' '));
      for (const r of new Set(rips.map(x => BigInt(x.split(':')[1]))))
        for (const m of (eng.maps || []))
          if (r >= BigInt(m.at) && r < BigInt(m.at) + BigInt(m.len))
            console.log(`    0x${r.toString(16)} = ${m.path} + 0x${(r - BigInt(m.at) + BigInt(m.off ?? 0)).toString(16)}`);
      console.log(`  fault ${e.message} ti ${eng.ti} ` +
                  `rips ${eng.threads.map(t => '0x' + t.cpu.rip.toString(16)).join(',')} ` +
                  `states ${eng.threads.map(t => t.state).join(',')}`);
      throw e;
    }
    if (eng.blocked) {
      const dl = eng.blocked.deadline;
      if (dl != null && eng.nowMs() >= dl) { eng.wake(); continue; }
      break;                                  // parked with nothing to deliver
    }
    if (eng.stats.interpreted + eng.stats.aotRuns === before) break;
  }
};
// WINDOWS=1 lists the mapped windows with geometry. Clicking at a guessed
// coordinate is how the first run of this harness "interacted" with GIMP and
// moved it 28 instructions: pick the target from the window tree instead.
if (process.env.WINDOWS) {
  const res = (snap.x?.res || []);
  const byId = new Map(res.map(w => [w.id, w]));
  const abs = (w) => { let x = 0, y = 0, c = w;
    while (c) { x += c.x; y += c.y; c = c.parent != null ? byId.get(c.parent) : null; }
    return [x, y]; };
  for (const w of res) {
    if (!w.mapped || w.cls === 2 || w.w < 24 || w.h < 12) continue;   // skip input-only and slivers
    const [x, y] = abs(w);
    if (x < 0 || y < 0 || x > 1024 || y > 768) continue;
    console.log(`  win 0x${w.id.toString(16)} at ${x},${y} ${w.w}x${w.h} mask 0x${(w.eventMask||0).toString(16)}` +
                ` center ${x + (w.w >> 1)},${y + (w.h >> 1)}`);
  }
  process.exit(0);
}

// No settle pump. Every thread restores parked on its own syscall and there
// is nothing to deliver yet; running an all-blocked engine is what sent a
// thread off into rip 0. The first thing that should happen is input.

// The same interaction N times. If the first is slower than the rest by more
// than the run-to-run spread, the tiering policy is the reason and #31 is real.
console.log('\n  n     ms   interp     aot   painted');
const rows = [];
for (let i = 0; i < N; i++) {
  const i0 = eng.stats.interpreted, a0 = eng.stats.aotRuns;
  const t0 = process.hrtime.bigint();
  // CLICKAT=x,y. The default was a guess at (420,30) that landed on the ROOT
  // window and moved GIMP 28 instructions - the point has to come from the
  // window tree (WINDOWS=1) or it is not an interaction at all.
  const [CX, CY] = (process.env.CLICKAT || '434,382').split(',').map(Number);
  xs.injectMotion(CX, CY); xs.injectButton(1, true);
  pump(1500, true);
  xs.injectButton(1, false);
  pump(1500, true);
  // Escape, not a second click. A click somewhere else leaves the UI in a
  // different state each round - the first run of this loop collapsed to 4ms
  // by iteration 2 because it had walked into a state where nothing responded.
  // Escape closes a menu and returns to where the round started, which is what
  // makes first-vs-Nth a comparison of the same interaction.
  xs.injectKey(9, true); xs.injectKey(9, false);     // keycode 9 = Escape
  pump(1500, true);
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

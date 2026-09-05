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
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
// CAPTURE=<file>: give the engine an assembler and record every unit it
// compiles while the interaction is driven, so the interactive path the
// pack-time capture missed can be captured FROM THE SHIPPED ARTIFACT - no
// sysroot needed, which this container does not have.
const CAPTURE = process.env.CAPTURE || null;
const captured = [];
let asmN = 0;
const assembleWat = (wat) => {
  const w = `/tmp/rp_${process.pid}_${asmN++}`;
  writeFileSync(w + '.wat', wat);
  execFileSync('wat2wasm', ['--enable-tail-call', w + '.wat', '-o', w + '.wasm']);
  const b = new Uint8Array(readFileSync(w + '.wasm'));
  try { unlinkSync(w + '.wat'); unlinkSync(w + '.wasm'); } catch {}
  return b;
};
const xs = new XServer({ width: root.w, height: root.h, fonts });
const eng = new LinuxEngine(elf, {
  argv: ['/usr/bin/gimp'],
  env: ['DISPLAY=:0', 'HOME=/root', 'USER=root',
        'LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu:/lib/x86_64-linux-gnu'],
  // the engine allocates memMB plus its own two reserved megabytes, so the
  // snapshot's memLen is memMB + 2 - solve for it rather than guessing
  files, mtimes: {}, memMB: Math.round(Number(memLen) / (1 << 20)) - 2, xserver: xs,
  // The page ships app.wabt.gz and sets eng.assembleWat once it loads, so the
  // engine there CAN compile units at runtime; only ?nowabt matches a replay
  // with no assembler. WABT=1 models the default page, so a manifest gap can
  // be told apart from a permanent hole: with an assembler the engine tiers
  // the missing functions up itself and the interpretation is a head-start
  // cost, without one it is forever.
  ...(CAPTURE || process.env.WABT ? { assembleWat } : {}) });
if (CAPTURE) eng.onUnitWat = (n, entry, unit) => {
  try { captured.push([entry.toString(16), assembleWat(unit.wat)]); } catch {}
};

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

// every captured unit, registered the way the page does it. EXTRA=<file> adds
// units captured by a previous CAPTURE run, which is how a fix to the manifest
// gets verified before anything is repacked.
let units = 0, fns = 0;
const unitSets = [container(gz('app.units.gz'))];
if (process.env.EXTRA && existsSync(process.env.EXTRA))
  unitSets.push(container(readFileSync(process.env.EXTRA)));
for (const [, bytes] of unitSets.flatMap(m => [...m])) {
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
// PROFILE=1: during round 0 only, step one instruction at a time and record
// the rip of every INTERPRETED step. 13,593 of them is a small enough
// population to keep whole. The question it answers is which kind of gap this
// is: code that has no compiled unit at all (a capture-coverage miss), or code
// whose unit exists and simply was not dispatched.
const profile = process.env.PROFILE ? new Map() : null;
// The engine already keeps a deopt-landing histogram behind a flag, which is
// the instrument this needs: a big interpreted count on a COMPILED address
// means the compiled code bailed out, and deoptLog says where it landed.
if (profile) eng.deoptLog = new Map();
// CONNECT the deopt landings to the interpreted steps instead of assuming the
// link. Both DeoptUnwind catch sites (linux.mjs:488 and :730) and the
// uncompiled-callout path all finish by calling interpUntil() with cpu.rip set
// to where they landed - so wrapping interpUntil attributes interpretation to
// the address that caused it. Whatever is left over is interpretation from the
// main run loop, which is a different problem with a different fix.
const viaInterpUntil = new Map();
let viaTotal = 0;
if (profile) {
  const inner = eng.interpUntil.bind(eng);
  // EXCLUSIVE attribution. interpUntil nests - a callout reached while
  // interpreting calls it again - so charging each frame its full delta
  // double-counts the inner ones and totals 112% of the round's interpreted
  // steps. Each frame is charged its delta MINUS what its children took.
  const stack = [];
  eng.interpUntil = (done) => {
    const at = eng.cpu.rip, before = eng.stats.interpreted;
    stack.push(0);
    try { return inner(done); }
    finally {
      const kids = stack.pop();
      const excl = (eng.stats.interpreted - before) - kids;
      if (stack.length) stack[stack.length - 1] += eng.stats.interpreted - before;
      if (excl > 0) { viaInterpUntil.set(at, (viaInterpUntil.get(at) || 0) + excl); viaTotal += excl; }
    }
  };
}
const profileRound = (ms) => {
  const t0 = process.hrtime.bigint();
  while (Number(process.hrtime.bigint() - t0) / 1e6 < ms) {
    const rip = eng.cpu.rip, before = eng.stats.interpreted;
    eng.run(1);
    // WEIGHT BY THE DELTA. eng.run(1) is a step BUDGET, not a single step -
    // interpreted can advance by a dozen instructions in one call. Counting
    // one hit per call captured 1,106 of the round's 13,565 steps and would
    // have been read as if it were the whole distribution.
    const d = eng.stats.interpreted - before;
    if (d > 0) profile.set(rip, (profile.get(rip) || 0) + d);
    if (eng.blocked) { const dl = eng.blocked.deadline;
      if (dl != null && eng.nowMs() >= dl) { eng.wake(); continue; } break; }
  }
};

console.log('\n  n     ms   interp     aot   painted');
const rows = [];
for (let i = 0; i < N; i++) {
  const i0 = eng.stats.interpreted, a0 = eng.stats.aotRuns;
  const t0 = process.hrtime.bigint();
  // SCRIPT is a ';'-separated round: "click:x,y", "esc", "drag:x1,y1,x2,y2".
  // One fixed click reaches one code path; the capture is only as good as the
  // interactions that drive it, and the units that matter are spread across
  // the toolbox, the menus and the paint path.
  const SCRIPT = process.env.SCRIPT ||
    `click:${process.env.CLICKAT || '434,382'};esc` +
    (process.env.DRAG ? `;drag:${process.env.DRAG}` : '');
  const P0 = profile && i === 0;
  const step = () => { if (P0) { eng.wake(); profileRound(1500); } else pump(1500, true); };
  for (const act of SCRIPT.split(';').filter(Boolean)) {
    const [kind, args] = act.split(':');
    const a = (args || '').split(',').map(Number);
    if (kind === 'click') { xs.injectMotion(a[0], a[1]); xs.injectButton(1, true); step();
                            xs.injectButton(1, false); step(); }
    else if (kind === 'esc') { xs.injectKey(9, true); xs.injectKey(9, false); step(); }
    else if (kind === 'drag') {
      xs.injectMotion(a[0], a[1]); xs.injectButton(1, true);
      for (let k = 1; k <= 8; k++)
        xs.injectMotion(a[0] + ((a[2] - a[0]) * k / 8) | 0, a[1] + ((a[3] - a[1]) * k / 8) | 0);
      xs.injectButton(1, false); step();
    }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const interp = eng.stats.interpreted - i0, aot = eng.stats.aotRuns - a0;
  let painted = 0;
  try { const fb = xs.flush(); const bg = fb[0]; for (let p = 0; p < fb.length; p += 997) if (fb[p] !== bg) painted++; } catch {}
  rows.push({ ms, interp, aot });
  console.log(`  ${i}  ${ms.toFixed(0).padStart(5)}  ${String(interp).padStart(8)}  ${String(aot).padStart(6)}  ${painted}`);
}
if (profile) {
  const byMap = new Map();
  const top = [...profile].sort((a, b) => b[1] - a[1]);
  let total = 0;
  for (const [rip, n] of profile) {
    total += n;
    let where = 'main-binary';
    for (const m of (eng.maps || []))
      if (rip >= BigInt(m.at) && rip < BigInt(m.at) + BigInt(m.len)) { where = m.path.split('/').pop(); break; }
    byMap.set(where, (byMap.get(where) || 0) + n);
  }
  console.log(`\ninterpreted in round 0: ${total} steps over ${profile.size} distinct addresses`);
  console.log('  by image: ' + [...byMap].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([k, v]) => `${k}:${v}`).join(' '));
  // An address in no `maps` entry is NOT automatically the main binary.
  // execRangesStatic[0] starts at 0x400000 here while the guest gimp is a PIE
  // 6MB long, so labelling 0x1c90631 as "gimp+0x1890631" was nonsense - past
  // the end of the file. Say unmapped and mean it.
  console.log(`  main exec range 0x${(eng.execRangesStatic?.[0]?.[0] ?? 0n).toString(16)}` +
              `..0x${(eng.execRangesStatic?.[0]?.[1] ?? 0n).toString(16)}`);
  console.log(`  deopts in round 0: ${eng.stats.deopts || 0}` +
              (eng.deoptLog ? ` over ${eng.deoptLog.size} distinct landings` : ''));
  for (const [t, n] of [...(eng.deoptLog || new Map())].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    let where = 'main';
    for (const m of (eng.maps || []))
      if (t >= BigInt(m.at) && t < BigInt(m.at) + BigInt(m.len))
        { where = `${m.path.split('/').pop()}+0x${(t - BigInt(m.at) + BigInt(m.off ?? 0)).toString(16)}`; break; }
    if (where === 'main') where = 'in no mapped image';
    console.log(`    deopt ${String(n).padStart(6)}  0x${t.toString(16)}  ${where}` +
                `  [${eng.aotFns.has(t) ? 'landing compiled' : 'landing NOT compiled - interpreter runs it'}]`);
  }
  console.log(`  interpreted VIA interpUntil (deopt/callout landings): ${viaTotal}` +
              ` of ${total} = ${(viaTotal / (total || 1) * 100).toFixed(0)}%` +
              ` over ${viaInterpUntil.size} landings`);
  for (const [t, n] of [...viaInterpUntil].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    let where = 'in no mapped image';
    for (const m of (eng.maps || []))
      if (t >= BigInt(m.at) && t < BigInt(m.at) + BigInt(m.len))
        { where = `${m.path.split('/').pop()}+0x${(t - BigInt(m.at) + BigInt(m.off ?? 0)).toString(16)}`; break; }
    // why is the interpreter running this at all?
    const why = eng.aotFns.has(t) ? 'compiled (so this is a deopt INTO it)'
              : eng.aotFailed.has(t) ? 'POISONED - compilation refused it'
              : 'never compiled - no unit covers it';
    console.log(`    ${String(n).padStart(6)}  0x${t.toString(16)}  ${where}  [${why}]`);
  }
  console.log('  hottest interpreted addresses:');
  for (const [rip, n] of top.slice(0, 10)) {
    let where = 'main';
    for (const m of (eng.maps || []))
      if (rip >= BigInt(m.at) && rip < BigInt(m.at) + BigInt(m.len))
        { where = `${m.path.split('/').pop()}+0x${(rip - BigInt(m.at) + BigInt(m.off ?? 0)).toString(16)}`; break; }
    // CAREFUL with what this label means. The step budget is 1, so one call
    // executes one dispatch OR one interpreted instruction - but a dispatch
    // into a compiled function that DEOPTS runs x_deopt, which interprets a
    // long stretch while the recorded rip stays the AOT entry. So a big count
    // on an address that IS compiled does not mean dispatch missed it; it
    // means the compiled function bailed out and the interpreter ran inside
    // it. Distinguishing those needs the deopt landing rips (eng.ripTrace),
    // not this histogram.
    const known = eng.aotFns.has(rip) ? 'compiled: work is INSIDE it (deopt?)'
                : eng.aotFailed.has(rip) ? 'POISONED'
                : 'no compiled entry at this rip';
    console.log(`    ${String(n).padStart(5)}  0x${rip.toString(16)}  ${where}  [${known}]`);
  }
}

// OXWASM_PHASE=1 makes the emitter attribute its own time; print it here so a
// capture run doubles as a fixed-input emission benchmark (same snapshot,
// same entries, every run).
if (process.env.OXWASM_PHASE === '1' && globalThis.__aotPhase) {
  const p = globalThis.__aotPhase;
  const tot = p.analyze + p.inline + p.emit + p.ftscan;
  console.log(`\nemitter phases over ${p.units} units, ${tot.toFixed(0)}ms total`);
  console.log(`  analyze (decode closure) ${p.analyze.toFixed(0)}ms (${(100*p.analyze/tot).toFixed(0)}%)`);
  console.log(`  emit (wat text)          ${p.emit.toFixed(0)}ms (${(100*p.emit/tot).toFixed(0)}%)`);
  console.log(`  inline                   ${p.inline.toFixed(0)}ms (${(100*p.inline/tot).toFixed(0)}%)`);
  console.log(`  ftr scan of all texts    ${p.ftscan.toFixed(0)}ms (${(100*p.ftscan/tot).toFixed(0)}%)`);
  console.log(`  WAT chars emitted ${(p.chars/1e6).toFixed(1)}M over ${p.rounds} emit rounds` +
              ` (${(p.rounds/p.units).toFixed(2)} per unit); ${p.reemit} function re-emits from retries`);
}

if (CAPTURE && captured.length) {
  // same container shape as app.units: u32 index length, JSON index, bodies
  const idx = [], parts = []; let off = 0;
  for (const [name, buf] of captured) { idx.push([name, off, buf.length]); off += buf.length; parts.push(Buffer.from(buf)); }
  const ib = Buffer.from(JSON.stringify(idx));
  const hdr = Buffer.alloc(4); hdr.writeUInt32LE(ib.length, 0);
  writeFileSync(CAPTURE, Buffer.concat([hdr, ib, ...parts]));
  console.log(`\ncaptured ${captured.length} units -> ${CAPTURE}`);
}

const rest = rows.slice(1);
if (rest.length) {
  const med = [...rest].sort((a, b) => a.ms - b.ms)[rest.length >> 1];
  const spread = (Math.max(...rest.map(r => r.ms)) - Math.min(...rest.map(r => r.ms))) / med.ms * 100;
  console.log(`\nfirst ${rows[0].ms.toFixed(0)}ms vs median-of-rest ${med.ms.toFixed(0)}ms ` +
              `(${(rows[0].ms / med.ms).toFixed(2)}x), spread of the rest +/-${spread.toFixed(0)}%`);
  console.log(`first interp ${rows[0].interp} vs median-of-rest ${med.interp}`);
}

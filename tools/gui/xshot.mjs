// Run an X client until its window is painted, then dump the screen as text
// (which glyphs actually landed) — a GUI app never exits, so exit code is
// the wrong signal.
import { LinuxEngine } from '../../engine/linux.mjs';
import { XServer } from '../../engine/xserver.mjs';
import { readFileSync, readdirSync, lstatSync, realpathSync, writeFileSync,
         existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const files = {}, mtimes = {};
const add = (g,h)=>{ try { files[g]=new Uint8Array(readFileSync(h)); mtimes[g]=0; } catch{} };
for (const d of ['/lib/x86_64-linux-gnu','/usr/lib/x86_64-linux-gnu','/lib64']) {
  let e; try { e = readdirSync(d); } catch { continue; }
  for (const f of e) { try { const r=realpathSync(join(d,f)); if (lstatSync(r).isFile()) add(join(d,f),r); } catch{} } }
add('/etc/ld.so.cache','/etc/ld.so.cache');
// Xlib needs its locale database to build a fontset at all. Without it every
// run opened with "locale not supported by Xlib, locale set to C" and then
// "Unable to load any usable fontset" — a deficiency of the probe's file set,
// not of the server answering the font requests.
(function walkLocale(d, g) {
  let e; try { e = readdirSync(d); } catch { return; }
  for (const f of e) { const hp = join(d, f), gp = g + '/' + f;
    let st; try { st = lstatSync(hp); } catch { continue; }
    if (st.isDirectory()) walkLocale(hp, gp);
    else { try { add(gp, realpathSync(hp)); } catch {} } }
})('/usr/share/X11/locale', '/usr/share/X11/locale');
const bin = process.argv[2], args = process.argv.slice(3);
add(bin, bin);
// XSHOT_EXTRA=/bin/dash:/bin/ls — extra guest files. A terminal emulator
// spawns a shell, so the binary under test is not the only one it needs.
for (const p of (process.env.XSHOT_EXTRA || '').split(':').filter(Boolean)) add(p, p);
if (!files[bin]) { console.log('absent:', bin); process.exit(0); }
// Without an assembler the engine never tiers up and the whole run is the
// interpreter — far slower, which made "does it paint yet" unanswerable on
// any budget. Same cached wat2wasm as guishot; the cache is shared, so a
// second run of the same app reuses the first run's compilation.
const WATCACHE = new URL('./watcache/', import.meta.url).pathname;
try { mkdirSync(WATCACHE, { recursive: true }); } catch {}
let asmN = 0, watHits = 0, watMisses = 0;
const assembleWat = (wat) => {
  const h = createHash('sha1').update(wat).digest('hex');
  const cp = WATCACHE + h + '.wasm';
  if (existsSync(cp)) { watHits++; return new Uint8Array(readFileSync(cp)); }
  watMisses++;
  const w = `/tmp/xs_${process.pid}_${asmN++}`;
  writeFileSync(w + '.wat', wat);
  execFileSync('wat2wasm', ['--enable-tail-call', w + '.wat', '-o', w + '.wasm']);
  const bytes = new Uint8Array(readFileSync(w + '.wasm'));
  try { unlinkSync(w + '.wat'); unlinkSync(w + '.wasm'); } catch {}
  try { writeFileSync(cp, bytes); } catch {}
  return bytes;
};

const xs = new XServer({ width: 480, height: 200 });
// A run that spins at full CPU with no new pixels is either still working or
// stuck in a loop, and the two look identical from outside. Counting X
// requests separates them: a stuck client repeats the same opcode forever.
xs.countOps = true; xs.opCount = [];
const eng = new LinuxEngine(files[bin], { argv:[bin, ...args],
  env:['DISPLAY=:0','PATH=/bin:/usr/bin','HOME=/root','LANG=C','SHELL=/bin/sh','TERM=xterm'],
  files, mtimes, memMB: 512, xserver: xs, tty: !!process.env.XSHOT_TTY, assembleWat });
// XSHOT_POLLDBG=<seconds> — after that long, log what the guest is polling
// on. A client spinning in poll() rather than blocking is the shape of an
// unimplemented or wrongly-answered wait, and this names the fds and the
// requested event mask.
if (process.env.XSHOT_POLLDBG) eng.debugPollAfter = Number(process.env.XSHOT_POLLDBG) * 1000;

const t0 = Date.now(); let painted = 0;
// A cold Xt app can take many minutes to reach first paint, and a run that
// only prints at the end loses everything if it is killed or the container
// restarts. Checkpoint progress to XSHOT_PROGRESS (default /tmp/xshot.progress)
// as it goes, so a partial run is still worth something.
const PROG = process.env.XSHOT_PROGRESS || '/tmp/xshot.progress';
let lastProg = 0;
// "Painted" means pixels that DIFFER FROM THE ROOT BACKGROUND. Counting
// non-zero pixels reported the whole screen the moment flush() ran, since
// flush fills it with the root colour — and before flush was called at all
// it reported zero however much the client had drawn. Both readings were
// artefacts of the probe, not of the app.
const inked = () => {
  try { xs.flush(); } catch {}
  const bg = xs.root?.bgPixel ?? 0;
  let n = 0;
  for (let i = 0; i < xs.fb.length; i++) if (xs.fb[i] !== bg) n++;
  return n;
};
const note = () => {
  const nz = inked();
  try { writeFileSync(PROG, `t=${((Date.now()-t0)/1000).toFixed(0)}s nonzero=${nz}px exit=${eng.exitCode} units=${watHits + watMisses}\n`
    + 'xreqs: ' + (xs.opCount || []).map((n, op) => n ? op + 'x' + n : null).filter(Boolean)
        .sort((a, b) => +b.split('x')[1] - +a.split('x')[1]).join(' ') + '\n'
    + 'windows: ' + (() => { const out = [];
        const walk = (w) => { if (!w) return;
          if (w.mapped && w.cls !== 2) out.push(`${w.w}x${w.h}@${w.x},${w.y}${w._drawn ? '' : ' UNDRAWN'}`);
          (w.children || []).forEach(walk); };
        try { walk(xs.root); } catch {}
        return out.slice(0, 10).join(' '); })() + '\n'
    + 'xdiag: ' + (typeof xs.diag === 'function' ? xs.diag().join(' | ') : 'n/a') + '\n'
    + 'syscalls: ' + Object.entries(eng.stats?.syscalls || {})
        .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, c]) => n + 'x' + c).join(' ')
        + ` blocked=${!!eng.blocked}\n`
    + 'stderr: ' + JSON.stringify((eng.stderr || []).join('').slice(0, 600)) + '\n'); } catch {}
  return nz;
};
try { while (eng.exitCode === null && Date.now()-t0 < (Number(process.env.XSHOT_MS) || 120000)) {
  eng.run(2e7); if (eng.blocked) eng.wake();
  const nz = inked();
  if (Date.now() - lastProg > 5000) { lastProg = Date.now(); note(); }
  if (nz > 200) { painted = nz; break; }
} } catch(e) { console.log('THREW:', e.message); }
note();
console.log(`${bin}: exit=${eng.exitCode} painted=${painted}px in ${((Date.now()-t0)/1000).toFixed(1)}s`);
console.log('stderr:', JSON.stringify((eng.stderr||[]).join('').slice(0,300)));
// render the framebuffer as coarse text so glyphs are checkable without a viewer
if (painted) {
  // Two backgrounds matter: the root, and whatever the window is filled
  // with. Marking every non-root pixel as ink renders the window as one
  // solid block and hides the text inside it, which is the thing actually
  // worth seeing. Treat the two most common colours as background.
  const freq = new Map();
  for (const v of xs.fb) freq.set(v, (freq.get(v) || 0) + 1);
  const common = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => e[0]);
  const isBg = (v) => common.includes(v);
  let out = '';
  for (let y = 0; y < xs.H; y += 2) { let line = '';
    for (let x = 0; x < xs.W; x += 1) line += isBg(xs.fb[y*xs.W+x]) ? ' ' : '#';
    if (line.trim()) out += line.replace(/\s+$/,'') + '\n'; }
  writeFileSync('/tmp/xshot.txt', out);
  console.log(out.split('\n').slice(0, 40).join('\n'));
}

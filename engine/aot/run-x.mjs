// Run an UNMODIFIED x86-64 X11 client on the M3 engine with the in-process
// X server as its display. The guest binary + its shared libraries come from
// a sysroot directory (extracted Ubuntu debs); input is injected on a script
// and the composited screen is written out as PPM screenshots.
//
//   node aot/run-x.mjs SYSROOT /usr/bin/xeyes OUTPREFIX [script]
import { LinuxEngine } from '../linux.mjs';
import { XServer } from '../xserver.mjs';
import { parsePCF } from '../pcf.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

const [sysroot, guestPath, outPrefix, script = 'idle'] = process.argv.slice(2);

// ---- files map: every regular file in the sysroot at its guest path --------
const files = {};
(function walk(dir, guest) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name), g = guest + '/' + name;
    let st; try { st = lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) {
      try { const real = realpathSync(p);
        if (lstatSync(real).isFile()) files[g] = new Uint8Array(readFileSync(real));
        else if (lstatSync(real).isDirectory()) walk(real, g);
      } catch {}
    } else if (st.isDirectory()) walk(p, g);
    else if (st.isFile()) files[g] = new Uint8Array(readFileSync(p));
  }
})(sysroot, '');
// the dynamic loader path the ELF names
if (files['/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2'] && !files['/lib64/ld-linux-x86-64.so.2'])
  files['/lib64/ld-linux-x86-64.so.2'] = files['/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2'];
if (files['/lib/x86_64-linux-gnu/ld-2.27.so'] && !files['/lib64/ld-linux-x86-64.so.2'])
  files['/lib64/ld-linux-x86-64.so.2'] = files['/lib/x86_64-linux-gnu/ld-2.27.so'];
// Debian keeps app-defaults in /etc/X11 with a /usr/lib/X11 symlink (from
// x11-common, which the sysroot skips) — provide the alias directly
for (const [g, b] of Object.entries(files))
  if (g.startsWith('/etc/X11/app-defaults/'))
    files['/usr/lib/X11/app-defaults/' + g.slice('/etc/X11/app-defaults/'.length)] = b;

// ---- fonts for the X server ------------------------------------------------
const fonts = {};
const fdir = process.env.XFONTS || join(sysroot, '../xroot-dl/xfonts/usr/share/fonts/X11/misc');
for (const name of ['6x13', '6x13B', '9x15', '9x15B', '6x10', '5x7']) {
  try { fonts[name.toLowerCase()] = parsePCF(gunzipSync(readFileSync(join(fdir, name + '.pcf.gz')))); }
  catch {}
}
fonts['cursor'] = fonts['6x13'];                          // glyph cursors: never rendered

const xs = new XServer({ width: 640, height: 480, fonts });

let asmN = 0;
const assembleWat = (wat) => {
  const w = `/tmp/rx_${process.pid}_${asmN++}`;
  writeFileSync(w + '.wat', wat);
  execFileSync('wat2wasm', [w + '.wat', '-o', w + '.wasm']);
  return new Uint8Array(readFileSync(w + '.wasm'));
};

const elf = files[guestPath];
if (!elf) { console.error('guest binary not in sysroot:', guestPath); process.exit(1); }
const eng = new LinuxEngine(elf, {
  argv: [guestPath],
  env: ['DISPLAY=:0', 'HOME=/root', 'USER=root',
        'XFILESEARCHPATH=/etc/X11/%T/%N%C:/etc/X11/%T/%N:/usr/lib/X11/%T/%N%C:/usr/lib/X11/%T/%N',
        'LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu:/lib/x86_64-linux-gnu'],
  files, memMB: 512, assembleWat, xserver: xs,
});

// ---- screenshots -----------------------------------------------------------
function shoot(tag) {
  const fb = xs.flush();
  const px = new Uint8Array(xs.W * xs.H * 3);
  for (let i = 0; i < fb.length; i++) {
    px[i * 3] = (fb[i] >> 16) & 0xff; px[i * 3 + 1] = (fb[i] >> 8) & 0xff; px[i * 3 + 2] = fb[i] & 0xff;
  }
  const hdr = new TextEncoder().encode(`P6\n${xs.W} ${xs.H}\n255\n`);
  const out = new Uint8Array(hdr.length + px.length);
  out.set(hdr); out.set(px, hdr.length);
  writeFileSync(`${outPrefix}-${tag}.ppm`, out);
  // quick stats: distinct colors + non-background pixels
  const seen = new Set(); let nonbg = 0;
  for (let i = 0; i < fb.length; i += 7) { seen.add(fb[i]); if (fb[i] !== 0x9a9a9a) nonbg++; }
  return { colors: seen.size, nonbg };
}

// ---- scripted input --------------------------------------------------------
// each action runs the FIRST time the guest goes idle (blocks with no deadline)
// after `afterIdle` prior idles
const SCRIPTS = {
  idle: [ { do: () => info('shot A', shoot('a')) } ],
  xeyes: [
    { do: () => { info('shot A', shoot('a')); xs.injectMotion(30, 30); } },
    { do: () => { info('shot B', shoot('b')); xs.injectMotion(600, 440); } },
    { do: () => { info('shot C', shoot('c')); } },
  ],
  xclock: [ { do: () => info('shot A', shoot('a')) } ],
  xcalc: [
    { do: () => { info('shot A', shoot('a')); clickAt(68, 195); } },    // "7"
    { do: () => { info('shot B', shoot('b')); clickAt(200, 255); } },   // "+"
    { do: () => { clickAt(156, 255); } },                               // "3"
    { do: () => { clickAt(200, 285); } },                               // "="
    { do: () => info('shot C', shoot('c')) },
  ],
};
function clickAt(rx, ry) {
  const top = xs.root.children.find(c => c.mapped);
  if (!top) return;
  xs.injectMotion(top.x + rx, top.y + ry);
  xs.injectButton(1, true); xs.injectButton(1, false);
}
function click(_) {
  // click in the middle of the mapped top-level window
  const top = xs.root.children.find(c => c.mapped);
  if (!top) return;
  const cx = top.x + (top.w >> 1), cy = top.y + (top.h >> 1);
  xs.injectMotion(cx, cy); xs.injectButton(1, true); xs.injectButton(1, false);
}
const info = (tag, s) => console.error(`[${tag}] colors=${s?.colors} nonbg=${s?.nonbg}`);

const actions = SCRIPTS[script] ?? SCRIPTS.idle;
let ai = 0, everBlocked = false, lastAction = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const t0 = Date.now();
const deadlineWall = t0 + Number(process.env.XRUN_MS ?? 90000);
const GAP = Number(process.env.XRUN_GAP ?? 1500);        // ms between scripted actions
for (;;) {
  eng.run(2e7);
  if (eng.exitCode !== null) { console.error('guest exited', eng.exitCode); break; }
  if (Date.now() > deadlineWall) { console.error('wall timeout'); break; }
  if (!eng.blocked) continue;                            // hit step cap while busy
  const d = eng.blocked.deadline;
  eng.wake();
  // once the app has settled into its event loop, run scripted actions on a
  // wall-time schedule (apps like xeyes never block indefinitely — they poll)
  if (!everBlocked) { everBlocked = true; lastAction = Date.now(); }
  if (ai < actions.length && Date.now() - lastAction >= GAP) {
    actions[ai++].do(); lastAction = Date.now();
    continue;
  }
  if (ai >= actions.length && Date.now() - lastAction >= GAP) {
    console.error('script done'); break;
  }
  if (d != null) {                                       // timed wait: let it elapse
    const wait = d - eng.nowMs();
    if (wait > 0) await sleep(Math.min(wait + 1, 60));
  } else {
    await sleep(20);                                     // idle: wait for scripted input
  }
}
const s = shoot('final');
console.error(`final: colors=${s.colors} nonbg=${s.nonbg} interp=${eng.stats.interpreted} aotRuns=${eng.stats.aotRuns} tiers=${JSON.stringify(eng.stats.tiers)}`);

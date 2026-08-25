#!/usr/bin/env node
// xpack — package an UNMODIFIED x86-64 Linux X11 GUI binary as a single
// static HTML file. The page runs the M3 engine (interpreter + runtime AOT
// JIT) and the in-process X11 server; a <canvas> is the screen, the page's
// mouse/keyboard are the input devices. No server, works offline.
//
//   node tools/xpack.mjs SYSROOT /usr/bin/xcalc -o xcalc.html --title xcalc
import { readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, '..', 'engine');

const args = process.argv.slice(2);
let sysroot = null, guestPath = null, out = 'x.html', title = null, W = 640, H = 480, fontDir = null, gtk = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-o') out = args[++i];
  else if (a === '--title') title = args[++i];
  else if (a === '--size') { const [w, h] = args[++i].split('x').map(Number); W = w; H = h; }
  else if (a === '--fonts') fontDir = args[++i];
  else if (a === '--gtk') gtk = true;
  else if (!sysroot) sysroot = a;
  else if (!guestPath) guestPath = a;
}
if (!sysroot || !guestPath) { console.error('usage: xpack SYSROOT /usr/bin/app [-o out.html] [--title T] [--size WxH] [--fonts DIR]'); process.exit(1); }
title ??= guestPath.split('/').pop();

// ---- collect guest files: the binary, its DT_NEEDED closure, X resources ---
const hostOf = {};                                       // guest path -> host path
const dirMtimes = {};
(function walk(dir, guest) {
  try { if (guest) dirMtimes[guest] = Math.floor(lstatSync(dir).mtimeMs / 1000); } catch {}
  for (const name of readdirSync(dir)) {
    const p = join(dir, name), g = guest + '/' + name;
    let st; try { st = lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) {
      try { const real = realpathSync(p);
        if (lstatSync(real).isFile()) hostOf[g] = real;
        else if (lstatSync(real).isDirectory()) walk(real, g);
      } catch {}
    } else if (st.isDirectory()) walk(p, g);
    else if (st.isFile()) hostOf[g] = p;
  }
})(sysroot, '');

// DT_NEEDED sonames from an ELF's dynamic section (no host tools needed)
function neededOf(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (dv.getUint32(0, true) !== 0x464c457f) return [];
  const phoff = Number(dv.getBigUint64(32, true));
  const phent = dv.getUint16(54, true), phnum = dv.getUint16(56, true);
  let dynOff = null, dynSz = 0;
  const loads = [];
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phent, type = dv.getUint32(o, true);
    if (type === 2) { dynOff = Number(dv.getBigUint64(o + 8, true)); dynSz = Number(dv.getBigUint64(o + 32, true)); }
    if (type === 1) loads.push({ off: Number(dv.getBigUint64(o + 8, true)), vaddr: Number(dv.getBigUint64(o + 16, true)), sz: Number(dv.getBigUint64(o + 32, true)) });
  }
  if (dynOff === null) return [];
  const v2o = (v) => { for (const s of loads) if (v >= s.vaddr && v < s.vaddr + s.sz) return s.off + (v - s.vaddr); return null; };
  let strtab = null; const needs = [];
  for (let o = dynOff; o + 16 <= dynOff + dynSz; o += 16) {
    const tag = Number(dv.getBigUint64(o, true)), val = Number(dv.getBigUint64(o + 8, true));
    if (tag === 5) strtab = v2o(val);
    if (tag === 1) needs.push(val);
    if (tag === 0) break;
  }
  if (strtab === null) return [];
  return needs.map(off => { let s = ''; for (let i = strtab + off; bytes[i]; i++) s += String.fromCharCode(bytes[i]); return s; });
}
const files = {};
const libdirs = ['/usr/lib/x86_64-linux-gnu', '/lib/x86_64-linux-gnu'];
const queue = [guestPath];
while (queue.length) {
  const g = queue.pop();
  if (files[g] || !hostOf[g]) continue;
  files[g] = readFileSync(hostOf[g]);
  for (const so of neededOf(files[g]))
    for (const d of libdirs) if (hostOf[d + '/' + so] && !files[d + '/' + so]) { queue.push(d + '/' + so); break; }
}
// libraries Xlib dlopens at runtime (not DT_NEEDED anywhere): the cursor-
// theme path in particular crashes if libXcursor loads partially
for (const so of ['libXcursor.so.1', 'libXfixes.so.3', 'libXrender.so.1']) {
  for (const d of libdirs) {
    const g = d + '/' + so;
    if (hostOf[g] && !files[g]) { files[g] = readFileSync(hostOf[g]);
      for (const dep of neededOf(files[g]))
        for (const dd of libdirs) if (hostOf[dd + '/' + dep] && !files[dd + '/' + dep]) { files[dd + '/' + dep] = readFileSync(hostOf[dd + '/' + dep]); break; }
      break; }
  }
}
// the PT_INTERP dynamic linker (not a DT_NEEDED entry)
for (const cand of ['/lib/x86_64-linux-gnu/ld-2.27.so', '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2', '/lib64/ld-linux-x86-64.so.2'])
  if (hostOf[cand]) { files[cand] = readFileSync(hostOf[cand]); break; }
// X resources the client stack reads at runtime (skip heavyweight locale data)
for (const [g, h] of Object.entries(hostOf)) {
  if (g.startsWith('/etc/X11/app-defaults/') ||
      (g.startsWith('/usr/share/X11/locale/') && /\/(C|locale\.alias|locale\.dir|compose\.dir)/.test(g)))
    files[g] = readFileSync(h);
}
// --gtk: the GTK2/cairo/pango/fontconfig runtime files. Generate the caches
// first by chrooting into the sysroot on the build host (same-arch binaries):
//   chroot SYSROOT /usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/gdk-pixbuf-query-loaders > .../loaders.cache
//   chroot SYSROOT /usr/bin/fc-cache -f
//   chroot SYSROOT .../gtk-query-immodules-2.0 > .../immodules.cache
if (gtk) {
  const GTKKEEP = [
    /^\/etc\/fonts\//, /^\/var\/cache\/fontconfig\//,
    /^\/usr\/share\/fonts\/truetype\/dejavu\/DejaVuSans(-Bold)?\.ttf$/,
    /^\/usr\/share\/fonts\/truetype\/dejavu\/DejaVuSansMono\.ttf$/,
    /^\/usr\/lib\/x86_64-linux-gnu\/gdk-pixbuf-2\.0\//,
    /^\/usr\/lib\/x86_64-linux-gnu\/gtk-2\.0\//,
    /^\/etc\/gtk-2\.0\//, /^\/usr\/share\/themes\/[^/]+\/gtk-2\.0\//,
    /^\/usr\/share\/mime\/mime\.cache$/,
  ];
  for (const [g, h] of Object.entries(hostOf))
    if (!files[g] && GTKKEEP.some(rx => rx.test(g))) {
      files[g] = readFileSync(h);
      if (g.endsWith('.so')) for (const dep of neededOf(files[g]))
        for (const dd of libdirs) if (hostOf[dd + '/' + dep] && !files[dd + '/' + dep]) { files[dd + '/' + dep] = readFileSync(hostOf[dd + '/' + dep]); break; }
    }
}
if (files['/lib/x86_64-linux-gnu/ld-2.27.so'] && !files['/lib64/ld-linux-x86-64.so.2'])
  files['/lib64/ld-linux-x86-64.so.2'] = files['/lib/x86_64-linux-gnu/ld-2.27.so'];
for (const [g, b] of Object.entries(files))
  if (g.startsWith('/etc/X11/app-defaults/'))
    files['/usr/lib/X11/app-defaults/' + g.slice('/etc/X11/app-defaults/'.length)] = b;
const mtimes = { ...dirMtimes };
for (const g of Object.keys(files))
  try { if (hostOf[g]) mtimes[g] = Math.floor(lstatSync(hostOf[g]).mtimeMs / 1000); } catch {}
console.log(`xpack: ${Object.keys(files).length} guest files`);

// ---- fonts (raw pcf.gz, parsed in-page) ------------------------------------
fontDir ??= join(sysroot, '..', 'xroot-dl', 'xfonts', 'usr', 'share', 'fonts', 'X11', 'misc');
const fontEntries = [];
for (const name of ['6x13', '6x13B', '9x15', '9x15B', '6x10']) {
  try { fontEntries.push([name.toLowerCase(), readFileSync(join(fontDir, name + '.pcf.gz')).toString('base64')]); }
  catch {}
}

// ---- engine modules as import-map data: URLs -------------------------------
const MODS = ['interp', 'decode', 'jit2', 'jitsimd', 'aot_wat', 'linux', 'xserver', 'pcf'];
const importMap = { imports: {} };
for (const m of MODS) {
  const src = readFileSync(join(ENGINE, m + '.mjs'), 'utf8').replace(/from '\.\/(\w+)\.mjs'/g, "from 'ox/$1'");
  importMap.imports['ox/' + m] = 'data:text/javascript;base64,' + Buffer.from(src).toString('base64');
}

const wabtJs = readFileSync('/tmp/package/index.js', 'utf8');
const gzb64 = (b) => gzipSync(b, { level: 9 }).toString('base64');
const fileEntries = Object.entries(files).map(([g, b]) => [g, gzb64(b)]);
const elfB64 = gzb64(files[guestPath]);

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>${title}</title>
<style>
  html,body{margin:0;height:100%;background:#0b0e14;color:#c8ccd4;font:13px/1.4 ui-monospace,Menlo,Consolas,monospace}
  #wrap{display:flex;flex-direction:column;align-items:center;padding:10px;gap:8px}
  h1{font-size:14px;color:#e6e9ef;margin:0} h1 b{color:#7aa2f7}
  #screen{background:#000;border-radius:6px;box-shadow:0 0 0 1px #1d2330,0 10px 34px rgba(0,0,0,.6);
    width:min(100vw - 20px, ${W}px);touch-action:none;image-rendering:pixelated;outline:none}
  #stat{color:#7d8590;font-size:11px;text-align:center}
  .ok{color:#9ece6a}.err{color:#f7768e}
</style>
</head>
<body>
<div id="wrap">
  <h1><b>oxwasm</b> · ${title} — an unmodified x86-64 Linux GUI binary, running in this tab</h1>
  <canvas id="screen" width="${W}" height="${H}" tabindex="0"></canvas>
  <div id="stat">loading…</div>
</div>
<script>${wabtJs}</script>
<script type="importmap">${JSON.stringify(importMap)}</script>
<script type="module">
import { LinuxEngine } from 'ox/linux';
import { XServer } from 'ox/xserver';
import { parsePCF } from 'ox/pcf';
const stat = document.getElementById('stat'), cv = document.getElementById('screen');
const ctx = cv.getContext('2d');
async function inflate(b64) {
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const r = new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip')));
  return new Uint8Array(await r.arrayBuffer());
}
(async () => {
  const wabt = await WabtModule();
  const assembleWat = (wat) => {
    const m = wabt.parseWat('unit.wat', wat);
    const bin = m.toBinary({}).buffer; m.destroy();
    return new Uint8Array(bin);
  };
  const fonts = {};
  for (const [name, b64] of ${JSON.stringify(fontEntries)}) fonts[name] = parsePCF(await inflate(b64));
  const xs = new XServer({ width: ${W}, height: ${H}, fonts });
  const files = {};
  for (const [g, b] of ${JSON.stringify(fileEntries)}) files[g] = await inflate(b);
  const elf = await inflate(${JSON.stringify(elfB64)});
  stat.textContent = 'starting…';
  const eng = new LinuxEngine(elf, {
    argv: [${JSON.stringify(guestPath)}],
    env: ['DISPLAY=:0','HOME=/root','USER=root',
          'XFILESEARCHPATH=/etc/X11/%T/%N%C:/etc/X11/%T/%N:/usr/lib/X11/%T/%N%C:/usr/lib/X11/%T/%N',
          'LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu:/lib/x86_64-linux-gnu'],
    files, mtimes: ${JSON.stringify(mtimes)}, memMB: 512, assembleWat, xserver: xs });

  // ---- screen blit ----
  const img = ctx.createImageData(${W}, ${H});
  const px = new Uint8ClampedArray(img.data.buffer);
  function blit() {
    const fb = xs.flush();
    for (let i = 0; i < fb.length; i++) {
      const p = fb[i], o = i * 4;
      px[o] = (p >> 16) & 0xff; px[o + 1] = (p >> 8) & 0xff; px[o + 2] = p & 0xff; px[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  // ---- input ----
  const scale = () => cv.width / cv.getBoundingClientRect().width;
  const pos = (e) => { const r = cv.getBoundingClientRect(); const s = scale();
    return [ (e.clientX - r.left) * s, (e.clientY - r.top) * s ]; };
  let pumping = false;
  const poke = () => { if (!pumping) pump(); };
  cv.addEventListener('pointermove', (e) => { const [x, y] = pos(e); xs.injectMotion(x, y); poke(); });
  cv.addEventListener('pointerdown', (e) => { cv.focus(); const [x, y] = pos(e); xs.injectMotion(x, y);
    xs.injectButton(e.button === 2 ? 3 : e.button === 1 ? 2 : 1, true); e.preventDefault(); poke(); });
  cv.addEventListener('pointerup', (e) => { xs.injectButton(e.button === 2 ? 3 : e.button === 1 ? 2 : 1, false); e.preventDefault(); poke(); });
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  const KC = { Escape:9, Digit1:10, Digit2:11, Digit3:12, Digit4:13, Digit5:14, Digit6:15, Digit7:16,
    Digit8:17, Digit9:18, Digit0:19, Minus:20, Equal:21, Backspace:22, Tab:23,
    KeyQ:24, KeyW:25, KeyE:26, KeyR:27, KeyT:28, KeyY:29, KeyU:30, KeyI:31, KeyO:32, KeyP:33,
    BracketLeft:34, BracketRight:35, Enter:36, ControlLeft:37,
    KeyA:38, KeyS:39, KeyD:40, KeyF:41, KeyG:42, KeyH:43, KeyJ:44, KeyK:45, KeyL:46,
    Semicolon:47, Quote:48, Backquote:49, ShiftLeft:50, Backslash:51,
    KeyZ:52, KeyX:53, KeyC:54, KeyV:55, KeyB:56, KeyN:57, KeyM:58, Comma:59, Period:60, Slash:61,
    ShiftRight:62, AltLeft:64, Space:65, CapsLock:66,
    F1:67,F2:68,F3:69,F4:70,F5:71,F6:72,F7:73,F8:74,F9:75,F10:76,
    ArrowUp:111, ArrowLeft:113, ArrowRight:114, ArrowDown:116,
    Home:110, End:115, PageUp:112, PageDown:117, Insert:118, Delete:119, ControlRight:105, AltRight:108 };
  cv.addEventListener('keydown', (e) => { const k = KC[e.code]; if (k) { xs.injectKey(k, true); e.preventDefault(); poke(); } });
  cv.addEventListener('keyup', (e) => { const k = KC[e.code]; if (k) { xs.injectKey(k, false); e.preventDefault(); poke(); } });

  // ---- engine pump with blocking support ----
  const t0 = performance.now();
  let timer = null;
  function pump() {
    pumping = true;
    if (timer) { clearTimeout(timer); timer = null; }
    for (let spins = 0; spins < 40; spins++) {
      eng.run(2e6);
      if (eng.exitCode !== null) break;
      if (eng.blocked) break;
    }
    if (xs.dirty) blit();
    const s = eng.stats;
    stat.textContent = \`interp \${s.interpreted.toLocaleString()} · aot units \${s.tiers.aot||0} · \${((performance.now()-t0)/1000).toFixed(0)}s\`;
    if (eng.exitCode !== null) { stat.innerHTML += eng.exitCode === 0 ? ' · <span class="ok">exit 0</span>' : \` · <span class="err">exit \${eng.exitCode}</span>\`; pumping = false; return; }
    if (eng.blocked) {
      const d = eng.blocked.deadline;
      eng.wake();
      if (d != null) { timer = setTimeout(pump, Math.max(0, Math.min(d - performance.now(), 250))); pumping = false; return; }
      pumping = false; return;                       // idle: input events poke the pump
    }
    timer = setTimeout(pump, 0);
    pumping = false;
  }
  blit();
  pump();
})().catch(e => { stat.innerHTML = '<span class="err">' + e.message + '</span>'; console.error(e); });
</script>
</body>
</html>`;

writeFileSync(out, html);
console.log(`xpack: wrote ${out} (${(html.length / 1e6).toFixed(2)} MB, self-contained)`);

#!/usr/bin/env node
// xpack — package an UNMODIFIED x86-64 Linux X11 GUI binary as a single
// static HTML file. The page runs the M3 engine (interpreter + runtime AOT
// JIT) and the in-process X11 server; a <canvas> is the screen, the page's
// mouse/keyboard are the input devices. No server, works offline.
//
//   node tools/xpack.mjs SYSROOT /usr/bin/xcalc -o xcalc.html --title xcalc
import { readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync, mkdirSync } from 'node:fs';
import { gzipSync, gunzipSync, brotliCompressSync, constants as zc } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, '..', 'engine');

const args = process.argv.slice(2);
let sysroot = null, guestPath = null, out = 'x.html', title = null, W = 640, H = 480, fontDir = null, gtk = false;
let snapPath = null, memMB = 512, extraArgs = [], unitsPath = null, sidecarDir = null, brQ = 9, dedup = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-o') out = args[++i];
  else if (a === '--title') title = args[++i];
  else if (a === '--size') { const [w, h] = args[++i].split('x').map(Number); W = w; H = h; }
  else if (a === '--fonts') fontDir = args[++i];
  else if (a === '--gtk') gtk = true;
  else if (a === '--snapshot') snapPath = args[++i];
  else if (a === '--units') unitsPath = args[++i];
  else if (a === '--sidecar') sidecarDir = args[++i];
  else if (a === '--brq') brQ = +args[++i];
  else if (a === '--dedup') dedup = true;
  else if (a === '--mem') memMB = +args[++i];
  else if (a === '--arg') extraArgs.push(args[++i]);
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
const MODS = ['interp', 'decode', 'jit2', 'jitsimd', 'aot_wat', 'linux', 'xserver', 'pcf', 'snapshot_core'];
const importMap = { imports: {} };
for (const m of MODS) {
  const src = readFileSync(join(ENGINE, m + '.mjs'), 'utf8').replace(/from '\.\/(\w+)\.mjs'/g, "from 'ox/$1'");
  importMap.imports['ox/' + m] = 'data:text/javascript;base64,' + Buffer.from(src).toString('base64');
}

// ---- --sidecar DIR: slim shell + streamed brotli sidecars ------------------
// Instead of one self-contained monolith, write:
//   index.html    — engine modules + the snapshot's framebuffer inlined (first
//                   paint is the app's real screen, before any fetch) + loader
//   app.state.br  — engine/X state, guest files, fonts (one binary container)
//   app.mem.br    — raw sparse memory tiles ('SPR2'), streamed straight into
//                   wasm memory as bytes arrive
//   app.units.br  — pre-compiled AOT units, fetched in parallel but applied
//                   after interactivity; until then tier-up is parked
//                   (thresholds Infinity), so a hot function simply stays
//                   interpreted instead of poisoning
// Sidecars are stored brotli-compressed; a server (tools/gui/serve.mjs) sends
// them with Content-Encoding: br and the browser decodes natively while
// streaming. Everything inside the containers is stored raw for that reason.
if (sidecarDir) {
  if (!snapPath) { console.error('xpack: --sidecar requires --snapshot'); process.exit(1); }
  mkdirSync(sidecarDir, { recursive: true });
  const br = (b, q) => brotliCompressSync(b, { params: {
    [zc.BROTLI_PARAM_QUALITY]: q, [zc.BROTLI_PARAM_LGWIN]: 24,
    [zc.BROTLI_PARAM_SIZE_HINT]: b.length } });
  // container: [u32 idxLen][JSON [[name,off,len],...]][payload]
  const container = (sections) => {
    const idx = [], parts = []; let off = 0;
    for (const [name, buf] of sections) { idx.push([name, off, buf.length]); off += buf.length; parts.push(buf); }
    const ib = Buffer.from(JSON.stringify(idx));
    const hdr = Buffer.alloc(4); hdr.writeUInt32LE(ib.length, 0);
    return Buffer.concat([hdr, ib, ...parts]);
  };
  const jsonRaw = readFileSync(snapPath + '.json');
  const blobsRaw = readFileSync(snapPath + '.blobs');
  // framebuffer preview: pull xs.fb straight out of the snapshot blobs
  const stJ = JSON.parse(jsonRaw.toString('utf8'));
  const fbRef = stJ.x && stJ.x.fb;
  const fbGzB64 = fbRef ? gzipSync(blobsRaw.subarray(fbRef.o, fbRef.o + fbRef.n), { level: 9 }).toString('base64') : null;
  // decode the sparse tiles (wasm-memory offset -> raw 1MB tile)
  const memF = readFileSync(snapPath + '.mem');
  const tiles = new Map();
  { let mo = 4;
    while (mo < memF.length) {
      const o = memF.readUIntLE(mo, 6), gzLen = memF.readUInt32LE(mo + 10); mo += 16;
      tiles.set(o, gunzipSync(memF.subarray(mo, mo + gzLen))); mo += gzLen;
    } }

  // ---- --dedup: drop pages byte-identical to sysroot files ------------------
  // A restored GIMP image is dominated by clean file-backed pages (mapped
  // library .text/.rodata, mmap'd data files). Those bytes ship as the files
  // themselves in a deferred 'rom' sidecar; the critical mem sidecar keeps
  // only dirty/heap pages. 'fills' records how to reconstruct: per file, runs
  // of [wasm-mem offset, file offset, len]. Pages whose file lives in the
  // state sidecar are refilled before the engine starts; the rest are marked
  // pending — the engine's Memory.pend guard stalls-and-retries any touch
  // until the rom stream delivers that file. Only pages inside non-writable
  // PT_LOAD segments (or non-ELF mmap sources) are deduped, so syscalls that
  // write into guest buffers can never target a pending page.
  const fills = [];                          // [path, inState, [[wOff,fOff,len],...]]
  const romSections = [];
  if (dedup) {
    const RAMOFF = 1 << 20;                  // LinuxEngine's ram offset in wasm memory
    const TILE = 1 << 20;
    const stFull = JSON.parse(jsonRaw.toString('utf8'), (_, x) =>
      typeof x === 'string' && x.startsWith('≠') ? BigInt('0x' + x.slice(1)) : x);
    const base = stFull.base;
    const roRanges = (b) => {                // non-writable PT_LOAD file ranges
      if (b.length < 64 || b.readUInt32LE(0) !== 0x464c457f) return [[0, b.length]];
      const phoff = Number(b.readBigUInt64LE(32)), phent = b.readUInt16LE(54), phnum = b.readUInt16LE(56);
      const ro = [];
      for (let i = 0; i < phnum; i++) {
        const o = phoff + i * phent;
        if (b.readUInt32LE(o) !== 1 || (b.readUInt32LE(o + 4) & 2)) continue;   // PT_LOAD, !PF_W
        const fo = Number(b.readBigUInt64LE(o + 8));
        ro.push([fo, fo + Number(b.readBigUInt64LE(o + 32))]);
      }
      return ro;
    };
    const fileBytes = new Map(), fileRO = new Map();
    const zeros = Buffer.alloc(4096);
    const pageAt = (off) => { const t = tiles.get(Math.floor(off / TILE) * TILE);
      return t ? t.subarray(off % TILE, (off % TILE) + 4096) : null; };
    // pass 1: candidate runs per file (nothing zeroed yet)
    const runsByFile = new Map();
    for (const m of stFull.maps ?? []) {
      if (!m.path || !hostOf[m.path]) continue;
      if (!fileBytes.has(m.path)) {
        try { fileBytes.set(m.path, readFileSync(hostOf[m.path])); } catch { fileBytes.set(m.path, null); }
        fileRO.set(m.path, fileBytes.get(m.path) ? roRanges(fileBytes.get(m.path)) : []);
      }
      const fb = fileBytes.get(m.path); if (!fb) continue;
      const ro = fileRO.get(m.path);
      const at = m.at, len = Number(m.len), fOff = Number(m.fileOff || 0);
      const runs = runsByFile.get(m.path) ?? runsByFile.set(m.path, []).get(m.path);
      let cur = null;
      for (let i = 0; i < len; i += 4096) {
        const fo = fOff + i;
        if (fo >= fb.length) break;
        if (!ro.some(([a, b2]) => fo >= a && Math.min(fo + 4096, fb.length) <= b2)) { cur = null; continue; }
        const wOff = RAMOFF + Number(at - base) + i;
        const pg = pageAt(wOff);
        if (!pg) { cur = null; continue; }
        const fpg = fb.subarray(fo, fo + 4096);
        const clean = fpg.length >= 4096 ? pg.equals(fpg)
          : pg.subarray(0, fpg.length).equals(fpg) && pg.subarray(fpg.length).equals(zeros.subarray(fpg.length));
        if (!clean) { cur = null; continue; }
        if (cur && cur[0] + cur[2] === wOff && cur[1] + cur[2] === fo) cur[2] += 4096;
        else runs.push(cur = [wOff, fo, 4096]);
      }
    }
    // pass 2: keep files worth shipping, zero their pages, emit fills + rom
    const HOT = [/\/ld-/, /libc[.-]/, /libpthread/, /libglib/, /libgobject/, /libgtk/, /libgdk/,
      /libpango/, /libcairo/, /libpixman/, /libX11/, /libgimp/, /^\/usr\/bin\//, /libfontconfig/, /libfreetype/];
    const score = (p) => /libicudata/.test(p) ? 999 : (HOT.findIndex(rx => rx.test(p)) + 1 || HOT.length + 1);
    const chosen = [];
    for (const [p, runs] of runsByFile) {
      const cleanBytes = runs.reduce((a, r) => a + r[2], 0);
      const inState = files[p] !== undefined;
      const fb = fileBytes.get(p);
      if (!inState && cleanBytes < Math.min(fb.length / 2, 2 << 20)) continue;   // not worth shipping
      chosen.push([p, inState, runs, cleanBytes]);
    }
    chosen.sort((a, b) => score(a[0]) - score(b[0]) || b[3] - a[3]);
    let dropped = 0;
    for (const [p, inState, runs] of chosen) {
      for (const [wOff, , rlen] of runs)
        for (let i = 0; i < rlen; i += 4096) { const pg = pageAt(wOff + i); if (pg) pg.fill(0); dropped += 4096; }
      fills.push([p, inState ? 1 : 0, runs]);
      if (!inState) romSections.push(['file:' + p, fileBytes.get(p)]);
    }
    // verify: replaying fills over the zeroed tiles must reproduce the original
    { const orig = new Map();
      let mo = 4;
      while (mo < memF.length) {
        const o = memF.readUIntLE(mo, 6), gzLen = memF.readUInt32LE(mo + 10); mo += 16;
        orig.set(o, gunzipSync(memF.subarray(mo, mo + gzLen))); mo += gzLen;
      }
      const rebuilt = new Map([...tiles].map(([o, t]) => [o, Buffer.from(t)]));
      const wr = (off, src) => { const t = rebuilt.get(Math.floor(off / TILE) * TILE);
        if (t) src.copy(t, off % TILE); };
      for (const [p, , runs] of fills) {
        const fb = fileBytes.get(p);
        for (const [wOff, fOff, rlen] of runs) {
          const avail = Math.max(0, Math.min(rlen, fb.length - fOff));
          for (let i = 0; i < avail; i += 4096)
            wr(wOff + i, fb.subarray(fOff + i, Math.min(fOff + i + 4096, fOff + avail)));
        }
      }
      for (const [o, t] of orig)
        if (!rebuilt.get(o).equals(t)) { console.error(`xpack: DEDUP VERIFY FAILED at tile 0x${o.toString(16)}`); process.exit(1); }
      console.log(`xpack: dedup dropped ${(dropped / 1048576).toFixed(0)} MB across ${fills.length} files (${romSections.length} in rom); verified bit-exact`);
    }
  }

  const stateSections = [['json', jsonRaw], ['blobs', blobsRaw]];
  stateSections.push(['fills', Buffer.from(JSON.stringify(fills))]);
  for (const [g, b] of Object.entries(files)) stateSections.push(['file:' + g, b]);
  for (const [n, b64] of fontEntries) stateSections.push(['font:' + n, Buffer.from(b64, 'base64')]);
  const stateBuf = container(stateSections);
  const romBuf = romSections.length ? container(romSections) : Buffer.alloc(0);
  // mem: 'SPR2' + repeat [u48 wasm-mem offset][u32 len][raw tile bytes]
  const memParts = [Buffer.from('SPR2')];
  const wordsZero = (t) => { for (let i = 0; i < t.length; i += 8) if (t.readBigUInt64LE(i) !== 0n) return false; return true; };
  for (const [o, t] of tiles) {
    if (dedup && wordsZero(t)) continue;                  // tile emptied by dedup
    const hdr = Buffer.alloc(10); hdr.writeUIntLE(o, 0, 6); hdr.writeUInt32LE(t.length, 6);
    memParts.push(hdr, t);
  }
  const memBuf = Buffer.concat(memParts);
  let unitsBuf = Buffer.alloc(0), nUnits = 0;
  try {
    const units = JSON.parse(readFileSync((unitsPath ?? snapPath) + '.units', 'utf8'));
    unitsBuf = container(units.map(([h, b64]) => [h, Buffer.from(b64, 'base64')]));
    nUnits = units.length;
  } catch {}

  const shell = `<!doctype html>
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
<script>
// first paint, before the engine modules even parse: the snapshot's own
// framebuffer, inlined. The page opens showing the app's real screen.
window.__oxPerf = {};
(async () => {
  const FB = ${JSON.stringify(fbGzB64)};
  if (!FB) return;
  const cv0 = document.getElementById('screen'), c0 = cv0.getContext('2d');
  const bin = atob(FB), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const r = new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip')));
  const fbb = new Uint8Array(await r.arrayBuffer());
  const fb = new Uint32Array(fbb.buffer, 0, ${W * H});
  const img = c0.createImageData(${W}, ${H});
  const px = new Uint8ClampedArray(img.data.buffer);
  for (let i = 0; i < fb.length; i++) { const p = fb[i], o = i * 4;
    px[o] = (p >> 16) & 255; px[o+1] = (p >> 8) & 255; px[o+2] = p & 255; px[o+3] = 255; }
  c0.putImageData(img, 0, 0);
  window.__oxPerf.fbPaint = performance.now();
})();
</script>
<script type="importmap">${JSON.stringify(importMap)}</script>
<script type="module">
import { LinuxEngine } from 'ox/linux';
import { XServer } from 'ox/xserver';
import { parsePCF } from 'ox/pcf';
import { restoreEngineCore } from 'ox/snapshot_core';
import { CPU } from 'ox/interp';
const P = window.__oxPerf;                         // load-time milestones (ms since nav)
const stat = document.getElementById('stat'), cv = document.getElementById('screen');
let timer = null;
const ctx = cv.getContext('2d');
const CFG = { W: ${W}, H: ${H}, memMB: ${memMB},
  argv: ${JSON.stringify([guestPath, ...extraArgs])},
  mtimes: ${JSON.stringify(mtimes)},
  hasRom: ${romSections.length > 0},
  sizes: { state: ${stateBuf.length}, mem: ${memBuf.length}, units: ${unitsBuf.length}, rom: ${romBuf.length} } };
async function inflate(b64) {
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const r = new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip')));
  return new Uint8Array(await r.arrayBuffer());
}
const inflateBytes = async (u) => {
  const r = new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip')));
  return new Uint8Array(await r.arrayBuffer());
};
const parseContainer = (bin) => {
  const ilen = new DataView(bin.buffer, bin.byteOffset, 4).getUint32(0, true);
  const idx = JSON.parse(new TextDecoder().decode(bin.subarray(4, 4 + ilen)));
  const body = bin.subarray(4 + ilen);
  const m = new Map();
  for (const [name, o, n] of idx) m.set(name, body.subarray(o, o + n));
  return m;
};
function sha1hex(str) {
  const te = new TextEncoder().encode(str);
  const ml = te.length, wl = ((ml + 8) >> 6) + 1, words = new Uint32Array(wl * 16);
  for (let i = 0; i < ml; i++) words[i >> 2] |= te[i] << (24 - (i & 3) * 8);
  words[ml >> 2] |= 0x80 << (24 - (ml & 3) * 8);
  words[wl * 16 - 1] = ml * 8;
  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
  const w = new Uint32Array(80), rl = (n, c) => (n << c) | (n >>> (32 - c));
  for (let b = 0; b < wl * 16; b += 16) {
    for (let i = 0; i < 16; i++) w[i] = words[b + i];
    for (let i = 16; i < 80; i++) w[i] = rl(w[i-3] ^ w[i-8] ^ w[i-14] ^ w[i-16], 1);
    let a = h0, e = h4, c = h2, d = h3, bb = h1;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (bb & c) | (~bb & d) : i < 40 ? bb ^ c ^ d
              : i < 60 ? (bb & c) | (bb & d) | (c & d) : bb ^ c ^ d;
      const k = i < 20 ? 0x5A827999 : i < 40 ? 0x6ED9EBA1 : i < 60 ? 0x8F1BBCDC : 0xCA62C1D6;
      const t = (rl(a, 5) + f + e + k + w[i]) | 0;
      e = d; d = c; c = rl(bb, 30); bb = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + bb) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}
(async () => {
  const img = ctx.createImageData(CFG.W, CFG.H);
  const px = new Uint8ClampedArray(img.data.buffer);
  const paintU32 = (fb) => {
    for (let i = 0; i < fb.length; i++) {
      const p = fb[i], o = i * 4;
      px[o] = (p >> 16) & 0xff; px[o + 1] = (p >> 8) & 0xff; px[o + 2] = p & 0xff; px[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  };
  stat.textContent = 'loading\\u2026';
  // ---- all fetches start now, in parallel ----
  const unitsResp = fetch('app.units');
  const memResp = fetch('app.mem');
  const state = parseContainer(new Uint8Array(await (await fetch('app.state')).arrayBuffer()));
  P.stateFetched = performance.now();
  const files = {}, fonts = {};
  for (const [name, bytes] of state) {
    if (name.startsWith('file:')) files[name.slice(5)] = bytes;
    else if (name.startsWith('font:')) fonts[name.slice(5)] = parsePCF(await inflateBytes(bytes));
  }
  const xs = new XServer({ width: CFG.W, height: CFG.H, fonts });
  const unitCache = new Map();
  const assembleWat = (wat) => {
    const hit = unitCache.get(sha1hex(wat));
    if (hit) return hit;
    throw new Error('unit not in cache');               // poisons to interp
  };
  const eng = new LinuxEngine(files[CFG.argv[0]], {
    argv: CFG.argv,
    env: ['DISPLAY=:0','HOME=/root','USER=root',
          'XFILESEARCHPATH=/etc/X11/%T/%N%C:/etc/X11/%T/%N:/usr/lib/X11/%T/%N%C:/usr/lib/X11/%T/%N',
          'LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu:/lib/x86_64-linux-gnu'],
    files, mtimes: CFG.mtimes, memMB: CFG.memMB, assembleWat, xserver: xs,
    aotCallThreshold: Infinity, aotLoopThreshold: Infinity });
  P.engineUp = performance.now();
  // ---- stream memory tiles straight into wasm memory ----
  {
    const all = new Uint8Array(eng.wmem.buffer);
    const rd = (await memResp).body.getReader();
    const hdr = new Uint8Array(10), hv = new DataView(hdr.buffer);
    let magicSkip = 4, hdrFill = 0, remaining = 0, dst = 0, got = 0, lastStat = 0;
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      let i = 0;
      while (i < value.length) {
        if (magicSkip > 0) { const n = Math.min(magicSkip, value.length - i); magicSkip -= n; i += n; continue; }
        if (remaining === 0) {
          const n = Math.min(10 - hdrFill, value.length - i);
          hdr.set(value.subarray(i, i + n), hdrFill); hdrFill += n; i += n;
          if (hdrFill === 10) {
            dst = hv.getUint32(0, true) + hv.getUint16(4, true) * 0x100000000;
            remaining = hv.getUint32(6, true); hdrFill = 0;
          }
          continue;
        }
        const n = Math.min(remaining, value.length - i);
        all.set(value.subarray(i, i + n), dst);
        dst += n; remaining -= n; i += n; got += n;
      }
      if (performance.now() - lastStat > 250) { lastStat = performance.now();
        stat.textContent = \`loading memory \${(got / 1048576) | 0} / \${(CFG.sizes.mem / 1048576) | 0} MB\`; }
    }
    P.memDone = performance.now();
  }
  // ---- fills: reconstruct pages that are byte-identical to shipped files ----
  // State-resident files refill immediately. Rom files stream in after
  // interactivity; their pages are marked pending and the engine's Memory
  // guard stalls-and-retries any touch until the bytes land.
  const fillsSec = state.get('fills');
  const fillList = fillsSec ? JSON.parse(new TextDecoder().decode(fillsSec)) : [];
  const allMem = new Uint8Array(eng.wmem.buffer);
  const applyFill = (fileB, runs) => {
    for (const [wOff, fOff, rlen] of runs) {
      const n = Math.max(0, Math.min(rlen, fileB.length - fOff));
      if (n > 0) allMem.set(fileB.subarray(fOff, fOff + n), wOff);
    }
  };
  const romFills = new Map();
  for (const [p, inState, runs] of fillList) {
    if (inState) applyFill(files[p], runs);
    else romFills.set(p, runs);
  }
  // NB: wasm-memory byte offsets exceed 2^31, so page math must use division,
  // never 32-bit bitwise shifts
  const pgOf = (o) => (o / 4096) | 0;
  let bitmap = null;
  if (romFills.size) {
    bitmap = new Uint8Array(Math.ceil(eng.wmem.buffer.byteLength / 32768) + 1);   // 1 bit per 4K page
    for (const runs of romFills.values())
      for (const [wOff, , rlen] of runs)
        for (let p = pgOf(wOff); p <= pgOf(wOff + rlen - 1); p++) bitmap[p >> 3] |= 1 << (p & 7);
    const RAMOFF = 1 << 20;
    eng.mem.pend = (addr, n) => {
      const off = RAMOFF + Number(addr - eng.base);
      if (off < 0) return;
      const p1 = pgOf(off + Number(n) - 1);
      for (let p = pgOf(off); p <= p1; p++)
        if (bitmap[p >> 3] & (1 << (p & 7))) { const e = new Error('page pending'); e.pending = true; throw e; }
    };
  }
  restoreEngineCore(eng, xs,
    { json: new TextDecoder().decode(state.get('json')), blobs: state.get('blobs'), mem: null },
    CPU, (x) => x);
  P.restored = performance.now();

  const blit = () => { const fb = xs.flush(); paintU32(fb); };
  // ---- input ----
  const scale = () => cv.width / cv.getBoundingClientRect().width;
  const pos = (e) => { const r = cv.getBoundingClientRect(); const s = scale();
    return [ (e.clientX - r.left) * s, (e.clientY - r.top) * s ]; };
  let pumping = false;
  const poke = () => { if (window.__oxReady && !pumping && !timer) timer = setTimeout(pump, 0); };
  cv.addEventListener('pointermove', (e) => { if (!window.__oxReady) return; const [x, y] = pos(e); xs.injectMotion(x, y); poke(); });
  cv.addEventListener('pointerdown', (e) => { if (!window.__oxReady) return; cv.focus({ preventScroll: true }); const [x, y] = pos(e); xs.injectMotion(x, y);
    xs.injectButton(e.button === 2 ? 3 : e.button === 1 ? 2 : 1, true); e.preventDefault(); poke(); });
  cv.addEventListener('pointerup', (e) => { if (!window.__oxReady) return; xs.injectButton(e.button === 2 ? 3 : e.button === 1 ? 2 : 1, false); e.preventDefault(); poke(); });
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
  cv.addEventListener('keydown', (e) => { if (!window.__oxReady) return; const k = KC[e.code]; if (k) { xs.injectKey(k, true); e.preventDefault(); poke(); } });
  cv.addEventListener('keyup', (e) => { if (!window.__oxReady) return; const k = KC[e.code]; if (k) { xs.injectKey(k, false); e.preventDefault(); poke(); } });

  // ---- engine pump ----
  const t0 = performance.now();
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
      pumping = false; return;
    }
    timer = setTimeout(pump, 0);
    pumping = false;
  }
  blit();
  window.__ox = { eng, xs, pump: () => pump() };
  window.__oxReady = true;
  P.ready = performance.now();
  pump();
  // ---- deferred, in priority order: rom (pending pages), then AOT units ----
  (async () => {
    if (CFG.hasRom && romFills.size) {
      // streaming container parse over a chunk list: as soon as one file's
      // bytes are complete, replay its fills, clear its pending bits, and
      // poke the pump (the engine may be stalled on exactly those pages)
      const rd = (await fetch('app.rom')).body.getReader();
      const chunks = []; let pos = 0, total = 0;
      const take = (start, len) => {
        const out = new Uint8Array(len);
        let skip = start - pos, o = 0;
        for (let ci = 0; ci < chunks.length && o < len; ci++) {
          const c = chunks[ci];
          if (skip >= c.length) { skip -= c.length; continue; }
          const n = Math.min(c.length - skip, len - o);
          out.set(c.subarray(skip, skip + n), o); o += n; skip = 0;
        }
        return out;
      };
      const dropTo = (abs) => { while (chunks.length && pos + chunks[0].length <= abs) { pos += chunks[0].length; chunks.shift(); } };
      let idx = null, idxEnd = 0, next = 0;
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        chunks.push(value); total += value.length;
        if (!idx && total >= 4) {
          const ilen = new DataView(take(0, 4).buffer).getUint32(0, true);
          if (total >= 4 + ilen) {
            idx = JSON.parse(new TextDecoder().decode(take(4, ilen)));
            idxEnd = 4 + ilen;
          }
        }
        if (!idx) continue;
        while (next < idx.length && total >= idxEnd + idx[next][1] + idx[next][2]) {
          const [name, o, n] = idx[next];
          const bytes = take(idxEnd + o, n);
          const p = name.slice(5);
          const runs = romFills.get(p);
          if (runs) {
            applyFill(bytes, runs);
            for (const [wOff, , rlen] of runs)
              for (let pg = pgOf(wOff); pg <= pgOf(wOff + rlen - 1); pg++) bitmap[pg >> 3] &= ~(1 << (pg & 7));
            files[p] ??= bytes;                       // late open() fallback
          }
          next++;
          dropTo(idxEnd + o + n);
          poke();
        }
        stat.textContent = \`streaming libraries \${(total / 1048576) | 0} / \${(CFG.sizes.rom / 1048576) | 0} MB\`;
      }
      eng.mem.pend = null;                            // everything landed
      P.romDone = performance.now();
      poke();
    }
    try {
      const ub = new Uint8Array(await (await unitsResp).arrayBuffer());
      if (ub.length) {
        for (const [h, bytes] of parseContainer(ub)) unitCache.set(h, bytes);
        eng.aotCallThreshold = 4; eng.aotLoopThreshold = 12;
        eng.aotFailed.clear();                        // anything poisoned pre-units gets a real shot
        P.unitsApplied = performance.now();
      }
    } catch (e) { console.warn('units sidecar failed; staying interpreted', e); }
  })();
  // repeat visits come from the Cache API: a tiny service worker caches the
  // shell and sidecars on first use (works offline afterwards, and sidesteps
  // the browser HTTP cache's per-entry size limits)
  if (navigator.serviceWorker) navigator.serviceWorker.register('sw.js').catch(() => {});
})().catch(e => { stat.innerHTML = '<span class="err">' + e.message + '</span>'; console.error(e); });
</script>
</body>
</html>`;

  writeFileSync(join(sidecarDir, 'index.html'), shell);
  const w = (name, buf, q) => { const c = br(buf, q);
    writeFileSync(join(sidecarDir, name + '.br'), c);
    console.log(`xpack: ${name}.br ${(c.length / 1e6).toFixed(1)} MB (raw ${(buf.length / 1e6).toFixed(1)} MB, brotli q${q})`); };
  console.log(`xpack: shell ${(shell.length / 1e6).toFixed(2)} MB, ${nUnits} units deferred`);
  w('app.state', stateBuf, 11);
  w('app.mem', memBuf, memBuf.length < (100 << 20) ? 11 : brQ);
  w('app.units', unitsBuf, brQ);
  if (romBuf.length) w('app.rom', romBuf, brQ);
  writeFileSync(join(sidecarDir, 'sw.js'), `// cache-first for the app bundle: repeat visits load from the Cache API
const C = 'oxwasm-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  const name = u.pathname.split('/').pop() || 'index.html';
  if (e.request.method !== 'GET' ||
      !(name === 'index.html' || name === 'sw.js' || name.startsWith('app.'))) return;
  e.respondWith((async () => {
    const c = await caches.open(C);
    const hit = await c.match(e.request);
    if (hit) return hit;
    const resp = await fetch(e.request);
    if (resp.ok) c.put(e.request, resp.clone());
    return resp;
  })());
});
`);
  process.exit(0);
}

// --snapshot: inline the sparse snapshot (json+blobs gzip'd; mem tiles are
// already individually gzip'd, embedded as-is)
let snapAssets = null, unitsB64 = 'null';
if (snapPath) {
  // recompress the sparse tiles at max level: snapshot saves use level 1 for
  // speed; the pack is offline and can afford level 9 (~30% smaller page)
  const recompress = (f) => {
    if (f.subarray(0, 4).toString() !== 'SPRS') return f;
    const parts = [Buffer.from('SPRS')];
    let fo = 4;
    while (fo < f.length) {
      const o = f.readUIntLE(fo, 6), rawLen = f.readUInt32LE(fo + 6), gzLen = f.readUInt32LE(fo + 10); fo += 16;
      const gz = gzipSync(gunzipSync(f.subarray(fo, fo + gzLen)), { level: 9 }); fo += gzLen;
      const hdr = Buffer.alloc(16);
      hdr.writeUIntLE(o, 0, 6); hdr.writeUInt32LE(rawLen, 6); hdr.writeUInt32LE(gz.length, 10);
      parts.push(hdr, gz);
    }
    return Buffer.concat(parts);
  };
  snapAssets = {
    json: gzipSync(readFileSync(snapPath + '.json'), { level: 9 }).toString('base64'),
    blobs: gzipSync(readFileSync(snapPath + '.blobs'), { level: 9 }).toString('base64'),
    mem: recompress(readFileSync(snapPath + '.mem')).toString('base64'),
  };
  console.log(`xpack: snapshot inlined (${(snapAssets.mem.length / 1e6).toFixed(1)} MB mem b64)`);
  // pre-compiled unit cache: sha1(wat) -> wasm bytes, from the snapshot run.
  // In-page assembleWat serves these synchronously; wabt is only a fallback.
  // Packed as a binary container — u32le index length, JSON index of
  // [sha1, offset, len], then the raw wasm bytes concatenated — gzipped
  // once. gzip over raw bytes beats gzip over the old base64-in-JSON text
  // by ~25%, and the page serves each unit as a zero-copy subarray slice
  // instead of materializing a giant JSON string at restore.
  // --units PATH substitutes a different manifest (same format), e.g. one
  // recorded by a post-restore exercise run (guishot UNITSOUT) so only the
  // working set ships; a missed unit falls back to interp, still correct.
  try {
    const units = JSON.parse(readFileSync((unitsPath ?? snapPath) + '.units', 'utf8'));
    const idx = [], parts = []; let uo = 0;
    for (const [h, b64] of units) {
      const b = Buffer.from(b64, 'base64');
      idx.push([h, uo, b.length]); uo += b.length; parts.push(b);
    }
    const idxBuf = Buffer.from(JSON.stringify(idx));
    const hdr = Buffer.alloc(4); hdr.writeUInt32LE(idxBuf.length, 0);
    unitsB64 = JSON.stringify(gzipSync(Buffer.concat([hdr, idxBuf, ...parts]), { level: 9 }).toString('base64'));
    console.log(`xpack: ${units.length} pre-compiled units inlined (${(uo / 1e6).toFixed(1)} MB wasm${unitsPath ? ', pruned manifest' : ''})`);
  } catch { console.log('xpack: no .units manifest (browser tier-up will rely on wabt)'); }
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
import { restoreEngineCore } from 'ox/snapshot_core';
import { CPU } from 'ox/interp';
const stat = document.getElementById('stat'), cv = document.getElementById('screen');
let timer = null;
const ctx = cv.getContext('2d');
async function inflate(b64) {
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const r = new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip')));
  return new Uint8Array(await r.arrayBuffer());
}
(async () => {
  const wabt = await WabtModule();
  // compact synchronous sha1 (matches node's crypto sha1 hex) for unit-cache keys
  function sha1hex(str) {
    const te = new TextEncoder().encode(str);
    const ml = te.length, wl = ((ml + 8) >> 6) + 1, words = new Uint32Array(wl * 16);
    for (let i = 0; i < ml; i++) words[i >> 2] |= te[i] << (24 - (i & 3) * 8);
    words[ml >> 2] |= 0x80 << (24 - (ml & 3) * 8);
    words[wl * 16 - 1] = ml * 8;
    let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    const w = new Uint32Array(80), rl = (n, c) => (n << c) | (n >>> (32 - c));
    for (let b = 0; b < wl * 16; b += 16) {
      for (let i = 0; i < 16; i++) w[i] = words[b + i];
      for (let i = 16; i < 80; i++) w[i] = rl(w[i-3] ^ w[i-8] ^ w[i-14] ^ w[i-16], 1);
      let a = h0, e = h4, c = h2, d = h3, bb = h1;
      for (let i = 0; i < 80; i++) {
        const f = i < 20 ? (bb & c) | (~bb & d) : i < 40 ? bb ^ c ^ d
                : i < 60 ? (bb & c) | (bb & d) | (c & d) : bb ^ c ^ d;
        const k = i < 20 ? 0x5A827999 : i < 40 ? 0x6ED9EBA1 : i < 60 ? 0x8F1BBCDC : 0xCA62C1D6;
        const t = (rl(a, 5) + f + e + k + w[i]) | 0;
        e = d; d = c; c = rl(bb, 30); bb = a; a = t;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + bb) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
    }
    return [h0, h1, h2, h3, h4].map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }
  // binary unit container: u32le index length, JSON index [sha1, off, len],
  // raw wasm bytes — units are zero-copy subarray views into one buffer
  const unitCache = new Map();
  { const ub = ${unitsB64};
    if (ub) { const bin = await inflate(ub);
      const ilen = new DataView(bin.buffer, bin.byteOffset, 4).getUint32(0, true);
      const idx = JSON.parse(new TextDecoder().decode(bin.subarray(4, 4 + ilen)));
      const body = bin.subarray(4 + ilen);
      for (const [h, o, n] of idx) unitCache.set(h, body.subarray(o, o + n));
    } }
  const assembleWat = (wat) => {
    const hit = unitCache.get(sha1hex(wat));
    if (hit) return hit;
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
    argv: ${JSON.stringify([guestPath, ...extraArgs])},
    env: ['DISPLAY=:0','HOME=/root','USER=root',
          'XFILESEARCHPATH=/etc/X11/%T/%N%C:/etc/X11/%T/%N:/usr/lib/X11/%T/%N%C:/usr/lib/X11/%T/%N',
          'LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu:/lib/x86_64-linux-gnu'],
    files, mtimes: ${JSON.stringify(mtimes)}, memMB: ${memMB}, assembleWat, xserver: xs });
  const SNAP = ${snapAssets ? JSON.stringify(snapAssets) : 'null'};
  if (SNAP) {
    stat.textContent = 'restoring snapshot…';
    const raw = (b64) => { const bin = atob(b64), u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
    const inflateBytes = async (u) => {
      const r = new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip')));
      return new Uint8Array(await r.arrayBuffer());
    };
    const t0r = performance.now();
    await restoreEngineCore(eng, xs, {
      json: await inflateBytes(raw(SNAP.json)),
      blobs: await inflateBytes(raw(SNAP.blobs)),
      mem: raw(SNAP.mem),
    }, CPU, inflateBytes);
    stat.textContent = 'restored in ' + ((performance.now() - t0r) / 1000).toFixed(1) + 's';
  }

  window.__ox = { eng, xs, pump: () => pump() };   // debug/testing handle
  window.__oxReady = true;                         // input is live from here
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
  // defer: never run the engine synchronously inside an input handler — a
  // long pump would delay the matching pointerup, and the guest would see
  // press->release seconds apart (GTK menus treat that as press-hold-dismiss)
  const poke = () => { if (window.__oxReady && !pumping && !timer) timer = setTimeout(pump, 0); };
  cv.addEventListener('pointermove', (e) => { const [x, y] = pos(e); xs.injectMotion(x, y); poke(); });
  cv.addEventListener('pointerdown', (e) => { cv.focus({ preventScroll: true }); const [x, y] = pos(e); xs.injectMotion(x, y);
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

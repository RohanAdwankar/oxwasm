#!/usr/bin/env node
// m3pack — package an UNMODIFIED x86-64 Linux ELF as a single static HTML
// file that runs it in the browser on the M3 engine: tier-0 interpreter +
// runtime whole-frame AOT (x86-64 -> wasm, assembled in-page by wabt).
//
//   node tools/m3pack.mjs ./program -o out.html --arg md5sum --arg /data/f \
//        --file /data/f=./somefile --title "prog"
//
// The output is self-contained and offline: engine, wabt, the binary, and
// any data files are inlined. Nothing about the packaged program is special-
// cased — the engine sees only its bytes.
import { readFileSync, writeFileSync, readdirSync, statSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, '..', 'engine');

const args = process.argv.slice(2);
let elfPath = null, out = 'm3.html', title = 'oxwasm m3';
let argv = [], files = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-o') out = args[++i];
  else if (a === '--arg') argv.push(args[++i]);
  else if (a === '--file') { const [g, h] = args[++i].split('='); files[g] = h; }
  else if (a === '--title') title = args[++i];
  else if (!elfPath) elfPath = a;
  else { console.error('unknown arg', a); process.exit(1); }
}
if (!elfPath) { console.error('usage: m3pack ELF|AppImage [-o out.html] [--arg A]... [--file guest=host]...'); process.exit(1); }

// An AppImage target is unpacked host-side (its runtime needs FUSE, which no
// browser has): the payload files ride along in the guest FS under /app and
// the resolved inner ELF becomes the program. The app's own bytes stay
// unmodified — only the delivery changes.
{
  const head = readFileSync(elfPath).subarray(0, 12);
  if (head[8] === 0x41 && head[9] === 0x49 && head[10] === 0x02) {
    const dir = mkdtempSync(join(tmpdir(), 'oxai-'));
    const entry = execFileSync('python3', [join(HERE, 'appimage-extract.py'), elfPath, dir]).toString().trim();
    const walk = (d) => { for (const n of readdirSync(d)) {
      const p = join(d, n); const st = statSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) files['/app/' + relative(dir, p)] = p;
    } };
    walk(dir);
    const guestEntry = '/app/' + relative(dir, entry);
    argv = [guestEntry, ...argv.slice(argv[0] === elfPath ? 1 : 0)];
    console.log(`m3pack: AppImage payload — ${Object.keys(files).length} files, entry ${guestEntry}`);
    elfPath = entry;
  }
}

const gzb64 = (buf) => Buffer.from(gzipSync(buf, { level: 9 })).toString('base64');

// engine modules with relative imports rewritten to bare specifiers, so an
// import map can resolve them from data: URLs inside the page
const MODS = ['interp', 'decode', 'jit2', 'jitsimd', 'aot_wat', 'linux'];
const modSrc = {};
for (const m of MODS)
  modSrc[m] = readFileSync(join(ENGINE, m + '.mjs'), 'utf8')
    .replace(/from '\.\/(\w+)\.mjs'/g, "from 'ox/$1'");
const importMap = { imports: {} };
for (const m of MODS)
  importMap.imports['ox/' + m] = 'data:text/javascript;base64,' + Buffer.from(modSrc[m]).toString('base64');

const wabtJs = readFileSync('/tmp/package/index.js', 'utf8');   // wabt 1.0.39 UMD
const elfB64 = gzb64(readFileSync(elfPath));
const fileEntries = Object.entries(files).map(([g, h]) => [g, gzb64(readFileSync(h))]);

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  html,body{margin:0;height:100%;background:#0b0e14;color:#c8ccd4;font:13px/1.45 ui-monospace,Menlo,Consolas,monospace}
  #wrap{max-width:900px;margin:0 auto;padding:20px}
  h1{font-size:15px;color:#e6e9ef} h1 b{color:#7aa2f7}
  #meta{color:#7d8590;font-size:12px;margin:4px 0 14px}
  #term{background:#000;border-radius:8px;padding:14px;min-height:200px;white-space:pre-wrap;
    box-shadow:0 0 0 1px #1d2330,0 12px 40px rgba(0,0,0,.6);overflow:auto;max-height:70vh}
  #stat{margin-top:10px;color:#7d8590;font-size:12px}
  .ok{color:#9ece6a} .err{color:#f7768e}
</style>
</head>
<body>
<div id="wrap">
  <h1><b>oxwasm</b> · unmodified x86-64 Linux binary, executing in this tab</h1>
  <div id="meta">${title} — tier-0 interpreter + runtime AOT (x86-64 → WebAssembly, assembled in-page) · no server · works offline</div>
  <div id="term"></div>
  <div id="stat">loading…</div>
</div>
<script>${wabtJs}</script>
<script type="importmap">${JSON.stringify(importMap)}</script>
<script type="module">
import { LinuxEngine } from 'ox/linux';
const CONFIG = { argv: ${JSON.stringify(argv)}, title: ${JSON.stringify(title)} };
const term = document.getElementById('term'), stat = document.getElementById('stat');
const put = (s) => { term.textContent += s; term.scrollTop = term.scrollHeight; };
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
  const elf = await inflate(${JSON.stringify(elfB64)});
  const files = {};
  for (const [g, b] of ${JSON.stringify(fileEntries)}) files[g] = await inflate(b);
  stat.textContent = 'running…';
  const eng = new LinuxEngine(elf, { argv: CONFIG.argv, files, memMB: 512, assembleWat });
  let shown = 0;
  const t0 = performance.now();
  const pump = () => {
    eng.run(3e6);                                          // chunked so the page stays live
    const outText = eng.stdout.join('');
    if (outText.length > shown) { put(outText.slice(shown)); shown = outText.length; }
    const s = eng.stats;
    stat.innerHTML = \`interp \${s.interpreted.toLocaleString()} · aot units \${s.tiers.aot||0} · aot runs \${s.aotRuns.toLocaleString()} · \${((performance.now()-t0)/1000).toFixed(1)}s\`;
    if (eng.exitCode === null) setTimeout(pump, 0);
    else stat.innerHTML += eng.exitCode === 0
      ? ' · <span class="ok">exit 0</span>' : \` · <span class="err">exit \${eng.exitCode}</span>\`;
  };
  pump();
})().catch(e => { stat.innerHTML = '<span class="err">' + e.message + '</span>'; console.error(e); });
</script>
</body>
</html>`;

writeFileSync(out, html);
console.log(`m3pack: wrote ${out} (${(html.length / 1e6).toFixed(2)} MB, self-contained)`);

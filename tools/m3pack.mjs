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
import { readWabtJs } from './wabtjs.mjs';
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

// Dynamic executables: bundle the PT_INTERP dynamic linker and every library
// ldd resolves, each at the absolute path the guest will ask for. The app's
// bundled libs (AppImage payload under /app) take precedence via
// LD_LIBRARY_PATH.
const env = [];
function bundleDynamic(elfBytes, elfFsPath) {
  const dv = new DataView(elfBytes.buffer, elfBytes.byteOffset, elfBytes.length);
  if (dv.getUint32(0, true) !== 0x464c457f) return;
  const phoff = Number(dv.getBigUint64(32, true));
  const phentsize = dv.getUint16(54, true), phnum = dv.getUint16(56, true);
  let interp = null;
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    if (dv.getUint32(o, true) === 3) {
      const off = Number(dv.getBigUint64(o + 8, true)), sz = Number(dv.getBigUint64(o + 32, true));
      interp = Buffer.from(elfBytes.subarray(off, off + sz - 1)).toString();
    }
  }
  if (!interp) return;
  files[interp] = interp;                            // the dynamic linker itself
  try {
    const out = execFileSync('ldd', [elfFsPath], { env: { ...process.env } }).toString();
    for (const line of out.split('\n')) {
      const m = line.match(/=>\s*(\/\S+)/) || line.match(/^\s*(\/\S+\.so[\d.]*)\s/);
      if (m && m[1] !== interp) {
        files[m[1]] = m[1];
        const soname = m[1].split('/').pop();
        if (!files['/lib/x86_64-linux-gnu/' + soname]) files['/lib/x86_64-linux-gnu/' + soname] = m[1];
      }
    }
  } catch { /* ldd unavailable: caller must pass --file for each lib */ }
  env.push('LD_LIBRARY_PATH=/app/usr/lib:/app/lib:/lib/x86_64-linux-gnu');
  console.log(`m3pack: dynamic executable — bundled ${interp} + ${Object.keys(files).length - 1} resolved libraries`);
}

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

const wabtJs = readWabtJs({ required: true });   // wabt UMD, inlined so the page assembles units offline
bundleDynamic(readFileSync(elfPath), elfPath);
const elfB64 = gzb64(readFileSync(elfPath));
// mtimes ride along with the bytes. Dropping them makes every bundled file
// look like 1970 to the guest, and a zero timestamp is not "unknown" to the
// programs that read it: gzip refuses to store one, warns, and exits 2 where
// native exits 0. The node sweep never saw this because breadth.mjs passes
// mtimes and this packer did not.
const fileEntries = Object.entries(files).map(([g, h]) => [g, gzb64(readFileSync(h)), Math.floor(statSync(h).mtimeMs / 1000)]);

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
const CONFIG = { argv: ${JSON.stringify(argv)}, env: ${JSON.stringify(env)}, title: ${JSON.stringify(title)} };
const term = document.getElementById('term'), stat = document.getElementById('stat');
const put = (s) => { term.textContent += s; term.scrollTop = term.scrollHeight; };
async function inflate(b64) {
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const r = new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip')));
  return new Uint8Array(await r.arrayBuffer());
}
// wabt.js parses recursively on an emscripten stack of 64 kB, so past a
// certain s-expression nesting depth it overflows — and the overflow is a wasm
// trap, which leaves the instance dead: every later parse fails too, including
// a trivial module. One deep function therefore costs the whole run its AOT
// tier, silently, because a failed assembly is a legitimate deopt.
//
// So find the limit once, on an instance that is allowed to die, and refuse
// anything past it. A refused unit is one interpreted function; a trapped
// assembler is all of them. The limit is probed rather than hardcoded because
// it is a property of how this wabt build was compiled, not of wabt.
async function depthLimit() {
  let probe = await WabtModule();
  const fits = async (d) => {
    try { const m = probe.parseWat('p.wat', '(module (func $f ' + '(block '.repeat(d) + 'nop' + ') '.repeat(d) + '))',
                                   { tail_call: true }); m.destroy(); return true; }
    catch { probe = await WabtModule(); return false; }   // a success leaves the probe usable; an overflow destroys it, so replace it before the next check
  };
  let lo = 0, hi = 1024;
  while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (await fits(mid)) lo = mid; else hi = mid; }
  return lo;
}
// Max nesting in a WAT, ignoring parens inside strings.
const watDepth = (s) => {
  let d = 0, m = 0, q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') q = false; continue; }
    if (c === '"') q = true; else if (c === '(') { if (++d > m) m = d; } else if (c === ')') d--;
  }
  return m;
};
(async () => {
  const maxDepth = await depthLimit();
  const wabt = await WabtModule();
  let refused = 0;
  const assembleWat = (wat) => {
    // tail_call: the translator emits return_call for every chained call, so
    // without the feature every unit is "opcode not allowed".
    const d = watDepth(wat);
    if (d > maxDepth) { refused++; throw new Error('unit nests ' + d + ' deep; this wabt build takes ' + maxDepth); }
    const m = wabt.parseWat('unit.wat', wat, { tail_call: true });
    const bin = m.toBinary({}).buffer; m.destroy();
    return new Uint8Array(bin);
  };
  const elf = await inflate(${JSON.stringify(elfB64)});
  const files = {};
  const mtimes = {};
  for (const [g, b, mt] of ${JSON.stringify(fileEntries)}) { files[g] = await inflate(b); mtimes[g] = mt; }
  stat.textContent = 'running…';
  const eng = new LinuxEngine(elf, { argv: CONFIG.argv, env: CONFIG.env, files, mtimes, memMB: 512, assembleWat });
  let shown = 0;
  const t0 = performance.now();
  const pump = () => {
    eng.run(3e6);                                          // chunked so the page stays live
    const outText = eng.stdout.join('');
    if (outText.length > shown) { put(outText.slice(shown)); shown = outText.length; }
    const s = eng.stats;
    // refused units are named here because their whole cost is invisible
    // otherwise: the page is correct either way, just slower
    stat.innerHTML = \`interp \${s.interpreted.toLocaleString()} · aot units \${s.tiers.aot||0} · aot runs \${s.aotRuns.toLocaleString()}\` +
      (refused ? \` · \${refused} too deep to assemble (>\${maxDepth})\` : '') + \` · \${((performance.now()-t0)/1000).toFixed(1)}s\`;
    if (eng.exitCode === null) setTimeout(pump, 0);
    else {
      // eng.stdout is the decoded text and is what the terminal shows; it
      // cannot represent a binary stream, so the CHECK is over eng.stdoutBytes
      // - the raw chunks - via a digest a harness can compare against native.
      // gzip's output differs from native's in the four header bytes that hold
      // the file's mtime, which no text or length comparison can see.
      let n = 0; for (const c of eng.stdoutBytes) n += c.length;
      const raw = new Uint8Array(n); let o = 0;
      for (const c of eng.stdoutBytes) { raw.set(c, o); o += c.length; }
      let h1 = 0x811c9dc5, h2 = 0x01000193;                  // two FNV-1a streams, so the 64 bits a harness compares are not one 32-bit space
      for (let i = 0; i < raw.length; i++) {
        h1 = Math.imul(h1 ^ raw[i], 0x01000193) >>> 0;
        h2 = Math.imul(h2 + raw[i], 0x85ebca6b) >>> 0;
      }
      window.__oxMs = performance.now() - t0; window.__oxExit = eng.exitCode; window.__oxOut = outText;
      window.__oxOutLen = raw.length;
      window.__oxOutHash = h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
    }   // a machine-readable end for tools/pagerun.mjs and the clock bench/vspage.mjs subtracts; the line below is for people
    if (eng.exitCode !== null) stat.innerHTML += eng.exitCode === 0
      ? ' · <span class="ok">exit 0</span>' : \` · <span class="err">exit \${eng.exitCode}</span>\`;
  };
  pump();
})().catch(e => { stat.innerHTML = '<span class="err">' + e.message + '</span>'; console.error(e); });
</script>
</body>
</html>`;

writeFileSync(out, html);
console.log(`m3pack: wrote ${out} (${(html.length / 1e6).toFixed(2)} MB, self-contained)`);

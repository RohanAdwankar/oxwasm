#!/usr/bin/env node
// m3pack — package an UNMODIFIED x86-64 Linux ELF as a single static HTML
// file that runs it in the browser on the M3 engine: tier-0 interpreter +
// runtime whole-frame AOT (x86-64 -> wasm, assembled in-page by wabt).
//
//   node tools/m3pack.mjs ./program -o out.html --arg md5sum --arg /data/f \
//        --file /data/f=./somefile --title "prog"
//
// --train runs the program once HERE, at pack time, and embeds the wasm units
// it translated. The page registers those with no translation at all, which is
// where its startup goes: on sha256sum the floor is ~2500 ms, of which ~1850 ms
// is the translator generating 4.34 MB of WAT text, ~190 ms is the in-page
// assembler and ~15 ms is the browser compiling the result.
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
let argv = [], files = {}, train = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-o') out = args[++i];
  else if (a === '--arg') argv.push(args[++i]);
  else if (a === '--file') { const [g, h] = args[++i].split('='); files[g] = h; }
  else if (a === '--title') title = args[++i];
  else if (a === '--train') train = true;
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

// ---- optional pack-time training run -------------------------------------
// The units a run translates are a function of the guest's memory image and
// the entry address, and both are deterministic for a given binary, argv and
// memMB: two runs here produce the same 107 entries with byte-identical wasm.
// So they can be translated once, at pack time, and shipped.
//
// The training assembler is the wat2wasm CLI, one process per unit. That is
// slower than the in-page wabt and it is the right choice here: a fresh
// process cannot be poisoned by a too-deep unit the way one long-lived wabt
// instance is, so the manifest also carries units the page would have refused
// as too deep to assemble.
//
// Anything the training run did not reach still translates in the page. The
// manifest is an optimisation, never a requirement.
// Fingerprint over exactly the things a unit is compiled against: the program
// bytes, the argv and env that decide the guest's layout, and the memory size.
// The manifest and the binary always come from the same pack, so this never
// fires in normal use - it is here because the failure it prevents is silent
// and total. Handed a manifest trained on a different binary, the engine
// registers units whose addresses mean other code and the guest crashes
// somewhere unrelated, with nothing pointing back at the manifest.
const fingerprint = (buf) => {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < buf.length; i++) {
    h1 = Math.imul(h1 ^ buf[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 + buf[i], 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
};
const packFp = fingerprint(Buffer.concat([readFileSync(elfPath),
  Buffer.from(JSON.stringify([argv, env, 512]))]));

let manifestB64 = '';
if (train) {
  const { LinuxEngine } = await import(join(ENGINE, 'linux.mjs'));
  const tdir = mkdtempSync(join(tmpdir(), 'oxtrain-'));
  let tn = 0;
  const trainAsm = (wat) => {
    const f = join(tdir, 't' + (tn++));
    writeFileSync(f + '.wat', wat);
    execFileSync('wat2wasm', ['--enable-tail-call', f + '.wat', '-o', f + '.wasm']);
    return new Uint8Array(readFileSync(f + '.wasm'));
  };
  const tfiles = {}, tmtimes = {};
  for (const [g, h] of Object.entries(files)) { tfiles[g] = new Uint8Array(readFileSync(h)); tmtimes[g] = Math.floor(statSync(h).mtimeMs / 1000); }
  // Training has to ITERATE, because the manifest changes what it is training
  // for. A run with units already registered interprets less, so its loop
  // back-edge counters reach the tier-up threshold at different places, and it
  // asks for entries the previous round never saw. One round left 23 of the
  // page's 106 units still being translated in the browser. Feed each round's
  // manifest into the next and stop when a round adds nothing: that fixed
  // point is the set the page will actually ask for.
  const cap = new Map();
  const t0 = Date.now();
  let round = 0, lastExit = null;
  for (; round < 5; round++) {
    const before = cap.size;
    const eng = new LinuxEngine(new Uint8Array(readFileSync(elfPath)),
      { argv, env, files: tfiles, mtimes: tmtimes, memMB: 512, assembleWat: trainAsm });
    eng.unitBytes = (k) => cap.get(k);
    eng.onUnitBytes = (k, b) => { if (!cap.has(k)) cap.set(k, Buffer.from(b)); };
    const r0 = Date.now();
    // 3e6 is the PAGE's slice, not a round number: slice boundaries move the
    // preemption and pump points, which move which loop heads reach their
    // back-edge threshold, which changes the unit set. Training at 5e7 reached
    // a fixed point in one round here and still left the page translating 23
    // units, because it was a fixed point of a different schedule.
    while (eng.exitCode === null && Date.now() - r0 < 600000) { eng.run(3e6); if (eng.blocked) eng.wake(); }
    lastExit = eng.exitCode;
    console.log(`m3pack: training round ${round + 1}: ${cap.size - before} new units (${cap.size} total), exit ${eng.exitCode}`);
    if (cap.size === before) break;
  }
  // A training run that did not finish the program is not a reason to fail the
  // pack - the page still works - but it IS a reason to say so, because a
  // half-covered manifest looks like a working one.
  if (lastExit !== 0)
    console.log(`m3pack: WARNING training run exited ${lastExit}; the manifest covers only what ran before that`);
  // one blob rather than per-unit base64: entry u64le, length u32le, bytes
  let total = 0; for (const v of cap.values()) total += 12 + v.length;
  const blob = Buffer.alloc(total); let o = 0;
  for (const [k, v] of cap) { blob.writeBigUInt64LE(BigInt(k), o); blob.writeUInt32LE(v.length, o + 8); v.copy(blob, o + 12); o += 12 + v.length; }
  manifestB64 = gzb64(blob);
  console.log(`m3pack: trained ${cap.size} units over ${round + 1} rounds, ${(blob.length / 1e6).toFixed(2)} MB wasm -> ` +
              `${(manifestB64.length / 1e6).toFixed(2)} MB base64 in the page (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}

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
const MANIFEST = ${JSON.stringify(manifestB64)} || null;
const MANIFEST_FP = ${JSON.stringify(manifestB64 ? packFp : '')};
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
  // The depth probe binary-searches parseWat and rebuilds the module on every
  // overflow, so getting the assembler ready costs ~90 ms. Starting it before
  // the inflate and collecting it just before the guest runs - so the two
  // overlap - measured 791 ms against 775 ms over six alternating runs each:
  // no gain. Both are main-thread CPU, and interleaving two main-thread tasks
  // costs what running them in order costs.
  const w0 = performance.now();
  const maxDepth = await depthLimit();
  const wabt = await WabtModule();
  window.__oxWabtInitMs = performance.now() - w0;
  let refused = 0;
  // The page floor - what a short run costs before any input matters - is
  // ~2.2 s, and "ELF load, translation and in-page assembly" was as far as
  // anyone had broken it down. These split the assembler out of it: whether
  // shipping precompiled units would help depends entirely on this share, and
  // guessing at it would pick the work for the wrong reason.
  let asmMs = 0, asmN = 0, asmBytes = 0;
  // ... and V8's share, separately from the assembler's. Between them and the
  // total these say whether the floor is us generating WAT text, wabt parsing
  // it, or V8 compiling the result - three different pieces of work with three
  // different fixes, and the floor is most of what a short run costs.
  let wasmMs = 0;
  for (const k of ['Module', 'Instance']) {
    const O = WebAssembly[k];
    const W = function (...a) { const t = performance.now(); try { return new O(...a); } finally { wasmMs += performance.now() - t; window.__oxWasmMs = wasmMs; } };
    W.prototype = O.prototype; WebAssembly[k] = W;
  }
  const assembleWat = (wat) => {
    // tail_call: the translator emits return_call for every chained call, so
    // without the feature every unit is "opcode not allowed".
    const d = watDepth(wat);
    if (d > maxDepth) { refused++; throw new Error('unit nests ' + d + ' deep; this wabt build takes ' + maxDepth); }
    const a0 = performance.now();
    const m = wabt.parseWat('unit.wat', wat, { tail_call: true });
    const bin = m.toBinary({}).buffer; m.destroy();
    asmMs += performance.now() - a0; asmN++; asmBytes += wat.length;
    window.__oxAsmMs = asmMs; window.__oxAsmN = asmN; window.__oxAsmWatBytes = asmBytes;
    return new Uint8Array(bin);
  };
  // Everything before the guest's first instruction, split. With the manifest
  // registered up front the translator is no longer the floor, and what is
  // left had never been measured at all - it was just "page load and inflate".
  const b0 = performance.now();
  const elf = await inflate(${JSON.stringify(elfB64)});
  window.__oxElfMs = performance.now() - b0;
  const files = {};
  const mtimes = {};
  const f0 = performance.now();
  for (const [g, b, mt] of ${JSON.stringify(fileEntries)}) { files[g] = await inflate(b); mtimes[g] = mt; }
  window.__oxFilesMs = performance.now() - f0; window.__oxFilesN = Object.keys(files).length;
  stat.textContent = 'running…';
  const e0 = performance.now();
  const eng = new LinuxEngine(elf, { argv: CONFIG.argv, env: CONFIG.env, files, mtimes, memMB: 512, assembleWat });
  window.__oxEngMs = performance.now() - e0;
  window.__oxBootMs = performance.now() - b0;
  let shown = 0;
  // Total time inside tier-up, so the floor splits three ways: this minus the
  // assembler and V8 is the translator generating WAT text, which nothing had
  // ever separated from the two pieces that are easy to blame.
  let tierMs = 0;
  { const o = eng.tierUpAot.bind(eng);
    eng.tierUpAot = (a) => { const t = performance.now(); try { return o(a); } finally { tierMs += performance.now() - t; window.__oxTierMs = tierMs; } }; }
  const t0 = performance.now();
  // Precompiled units from the pack-time training run, if there was one. The
  // engine registers these with no translation and no assembler; anything not
  // in here still goes the long way.
  if (MANIFEST) {
    // refuse a manifest that was not trained against this exact program
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    const fp = new Uint8Array(elf.length + 0);
    for (let i = 0; i < elf.length; i++) { h1 = Math.imul(h1 ^ elf[i], 0x01000193) >>> 0; h2 = Math.imul(h2 + elf[i], 0x85ebca6b) >>> 0; }
    const tail = new TextEncoder().encode(JSON.stringify([CONFIG.argv, CONFIG.env, 512]));
    for (let i = 0; i < tail.length; i++) { h1 = Math.imul(h1 ^ tail[i], 0x01000193) >>> 0; h2 = Math.imul(h2 + tail[i], 0x85ebca6b) >>> 0; }
    const here = h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
    if (here !== MANIFEST_FP) throw new Error('precompiled units were trained against a different program (' + MANIFEST_FP + ' vs ' + here + ')');
    const blob = await inflate(MANIFEST);
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.length);
    const units = new Map();
    for (let o = 0; o + 12 <= blob.length; ) {
      const k = dv.getBigUint64(o, true), n = dv.getUint32(o + 8, true);
      units.set(k, blob.subarray(o + 12, o + 12 + n)); o += 12 + n;
    }
    window.__oxManifestUnits = units.size;
    // Register the WHOLE manifest before the guest runs a single instruction,
    // rather than handing the engine a unitBytes lookup it consults on demand.
    //
    // On demand is what the engine does in node, where instantiation is
    // synchronous - a unit is available the moment it is asked for. A browser
    // cannot compile a module of this size synchronously on the main thread,
    // so the engine takes its async path: it parks a null placeholder and the
    // unit appears some microtasks later. Execution continues interpreted
    // across that window, and the unit boundaries it establishes there are not
    // the ones a synchronous run establishes. Measured on sha256sum: the page
    // asked for 163 distinct entries against a training run's 116, and 10 of
    // the entries it wanted had run INSIDE a compiled unit in node rather than
    // being tiered separately.
    //
    // Instantiating up front removes the window. It costs one pass over the
    // manifest before the first instruction - V8 compiles 106 of these units
    // in 10-25 ms - and it is the same registration the engine does itself.
    const t0m = performance.now();
    let regd = 0;
    await Promise.all([...units.values()].map(async (bytes) => {
      const { instance } = await WebAssembly.instantiate(bytes, eng.aotImports());
      for (const name of Object.keys(instance.exports))
        if (name.startsWith('f_')) {
          const a = BigInt('0x' + name.slice(2));
          if (!eng.aotFns.get(a)) { eng.registerAotFn(a, instance.exports[name]); regd++; }
        }
      if (instance.exports.drive) eng.aotDrive = instance.exports.drive;
    }));
    window.__oxManifestFns = regd;
    window.__oxManifestMs = performance.now() - t0m;
  }
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
      window.__oxInterp = eng.stats.interpreted; window.__oxAotRuns = eng.stats.aotRuns;
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

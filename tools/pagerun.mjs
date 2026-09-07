// Browser-side gate for the CLI lane: pack a binary with m3pack, run the page
// in headless Chromium, and pass only if the terminal it prints and the exit
// code it reports match running the same binary natively.
//
//   node tools/pagerun.mjs /usr/bin/sha256sum --arg sha256sum --arg /data/f \
//        --file /data/f=/tmp/in.txt
//
// Nothing covered this before. The node sweep proves 170 binaries byte-exact
// against native, and the GUI page has pagecheck, but the thing the README's
// headline command produces - one self-contained HTML running an unmodified
// binary in a tab - had no check at all, which is how m3pack came to read
// wabt.js from a path that existed on one machine and die with ENOENT
// everywhere else without anything noticing.
import { spawn, execFileSync } from 'node:child_process';
import { openBrowser, waitForExit } from './cdp.mjs';
import { mkdtempSync, rmSync, existsSync, mkdirSync, copyFileSync, unlinkSync, statSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const bin = argv[0];
if (!bin) { console.error('usage: pagerun.mjs BINARY [--arg A]... [--file guest=host]...'); process.exit(1); }
// the guest argv m3pack will pass, so the native side can be run the same way
const guestArgs = [];
for (let i = 1; i < argv.length; i++) if (argv[i] === '--arg') guestArgs.push(argv[++i]);
const fileMap = new Map();
for (let i = 1; i < argv.length; i++) if (argv[i] === '--file') { const [g, h] = argv[++i].split('='); fileMap.set(g, h); }

// Native oracle: argv[0] is the program name the guest sees, so drop it. The
// remaining arguments have to be the SAME STRINGS the guest gets, because
// programs print their arguments - sha256sum's output is "<hash>  <path>", and
// running native against the host path instead reported a 12-byte difference
// that was entirely the filename. So each --file is materialised at its guest
// path on the host for the length of the native run, and removed after. A
// guest path that already exists on the host is refused rather than clobbered.
const planted = [];
for (const [g, h] of fileMap) {
  if (existsSync(g)) { console.log(`FAIL pagerun ${bin}: guest path ${g} already exists on the host; pick another`); process.exit(1); }
  mkdirSync(dirname(g), { recursive: true }); copyFileSync(h, g);
  // and the same mtime: copyFileSync stamps the copy with now, while the page
  // carries the mtime of the file m3pack packed. gzip stores that timestamp in
  // its header, so without this the two sides differ by four bytes for a
  // reason that is the harness, not the engine.
  const st = statSync(h); utimesSync(g, st.atime, st.mtime);
  planted.push(g);
}
const nativeArgs = guestArgs.slice(1);
let natBytes = Buffer.alloc(0), natCode = 0;
try { natBytes = execFileSync(bin, nativeArgs, { maxBuffer: 1 << 26 }); }
catch (e) { natBytes = e.stdout ?? Buffer.alloc(0); natCode = e.status ?? -1; }
finally { for (const g of planted) { try { unlinkSync(g); } catch {} } }
const natOut = natBytes.toString();
// The same digest the page computes over its raw stdout chunks. Comparing the
// decoded text instead cannot see a binary difference at all - gzip's output
// differs from native's in the four header bytes holding the file's mtime, and
// that divergence shipped for as long as the packer has existed.
const digest = (b) => { let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < b.length; i++) { h1 = Math.imul(h1 ^ b[i], 0x01000193) >>> 0; h2 = Math.imul(h2 + b[i], 0x85ebca6b) >>> 0; }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'); };
const natHash = digest(natBytes);

const dir = mkdtempSync('/tmp/oxpagerun_');
const page = join(dir, 'index.html');
let serve, chrome;
const done = (code, msg) => { console.log(msg); try { serve?.kill(); } catch {} try { chrome?.kill('SIGKILL'); } catch {}
                              try { rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(code); };
try { execFileSync(process.execPath, [join(here, 'm3pack.mjs'), bin, '-o', page, ...argv.slice(1)], { stdio: 'pipe' }); }
catch (e) { done(1, `FAIL pagerun ${bin}: m3pack: ${String(e.stderr || e.message).trim().split('\n').pop()}`); }

const port = 8600 + Math.floor(Math.random() * 400);
serve = spawn(process.execPath, [join(here, 'gui', 'serve.mjs'), dir, String(port)], { stdio: 'ignore' });
let br;
try { br = await openBrowser(); } catch (e) { done(1, `FAIL pagerun ${bin}: ${e.message}`); }
chrome = { kill: br.close };
const q = br.q;
await br.navigate(`http://127.0.0.1:${port}/index.html`);

// The page sets window.__oxExit when the guest exits; the status line is read
// only to explain a timeout.
const TIMEOUT_S = +(process.env.PAGERUN_TIMEOUT || 300);
const pageCode = await waitForExit(q, TIMEOUT_S);
if (pageCode === null) {
  const stat = (await q('document.getElementById("stat") ? document.getElementById("stat").textContent : ""')) || '';
  done(1, `FAIL pagerun ${bin}: no exit within ${TIMEOUT_S}s (stat: ${JSON.stringify(stat.slice(0, 160))})`);
}
// __oxOut is the guest's stdout as the engine has it; #term is the same text
// after the DOM has had it, and is the fallback for a page built before the
// signal existed.
const pageOut = (await q('typeof window.__oxOut === "string" ? window.__oxOut : document.getElementById("term").textContent')) || '';
const pageHash = await q('window.__oxOutHash'), pageLen = await q('window.__oxOutLen');

if (pageHash === natHash && pageLen === natBytes.length && pageCode === natCode)
  done(0, `ok   pagerun ${bin}: ${natBytes.length}B stdout (${natHash}) and exit ${natCode} identical to native, in the browser`);
let d = 0; while (d < pageOut.length && d < natOut.length && pageOut[d] === natOut[d]) d++;
done(1, `FAIL pagerun ${bin}: ${pageCode === natCode ? '' : `exit ${pageCode} vs native ${natCode}; `}` +
        `stdout ${pageLen}B/${pageHash} vs native ${natBytes.length}B/${natHash}` +
        (pageLen === natBytes.length ? ' (same length, different bytes)' : '') +
        `, first text difference at ${d}\n` +
        `  page:   ${JSON.stringify(pageOut.slice(Math.max(0, d - 20), d + 40))}\n` +
        `  native: ${JSON.stringify(natOut.slice(Math.max(0, d - 20), d + 40))}`);

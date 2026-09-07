// What the packed HTML file actually costs, against native, in a browser.
//
// Every other number in this project is measured under node: the engine
// imported as a module, driven by a harness. That is the translator's number,
// not the product's. The product is one HTML file in a tab, and this measures
// that — m3pack's page, served, run in headless Chromium, timed by the clock
// the page itself keeps (window.__oxMs, set when the guest exits).
//
// Two sizes and a subtraction, for the same reason bench/realab.mjs uses one:
// wall-clock on a real binary is mostly ELF load, tiering and wat2wasm, which
// are the same at both sizes. Subtract and what is left is the steady state —
// the part that is emulation. Both sides get the same treatment, so the ratio
// compares like with like.
//
//   node bench/vspage.mjs --big /tmp/big.txt --small /tmp/small.txt [--reps 3] \
//        -- /bin/gzip -9 -c {IN}
//
// {IN} is the guest path the input is mounted at; the same path is planted on
// the host for the native side so both see identical argv (a program that
// prints its filename otherwise differs for a reason that is not speed).
import { openBrowser, waitForExit } from '../tools/cdp.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, mkdirSync, copyFileSync, unlinkSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const dd = argv.indexOf('--');
if (dd < 0) { console.log('usage: vspage.mjs --big F --small F [--reps N] -- <binary> <args with {IN}>'); process.exit(1); }
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && i < dd ? argv[i + 1] : d; };
const BIG = opt('big'), SMALL = opt('small'), REPS = Number(opt('reps', 3));
const GUEST_IN = opt('guest-in', '/data/in');
const cmd = argv.slice(dd + 1);
if (!BIG || !SMALL) { console.log('need --big and --small'); process.exit(1); }
const bin = cmd[0], args = cmd.slice(1);
const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];

// Native side: plant the input at the guest path so argv matches, time the
// run, remove it. A guest path that already exists on the host is refused
// rather than clobbered.
const nativeOnce = (input) => {
  if (existsSync(GUEST_IN)) { console.log(`refusing: ${GUEST_IN} already exists on the host`); process.exit(1); }
  mkdirSync(dirname(GUEST_IN), { recursive: true }); copyFileSync(input, GUEST_IN);
  const t0 = process.hrtime.bigint();
  try { execFileSync(bin, args.map(a => a.replace('{IN}', GUEST_IN)), { stdio: ['ignore', 'ignore', 'ignore'], maxBuffer: 1 << 28 }); } catch {}
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  try { unlinkSync(GUEST_IN); } catch {}
  return ms;
};

// Browser side: pack once per input size (the input is inlined in the page),
// serve the directory, and reload the page once per rep. Reloading rather than
// re-launching keeps the browser's own startup out of every sample; the page's
// clock starts after wabt and the inflate anyway.
const dir = mkdtempSync('/tmp/oxvspage_');
const packFor = (input, name) => {
  const page = join(dir, name);
  execFileSync(process.execPath, [join(here, '..', 'tools', 'm3pack.mjs'), bin, '-o', page,
    '--arg', bin.split('/').pop(), ...args.flatMap(a => ['--arg', a.replace('{IN}', GUEST_IN)]),
    '--file', `${GUEST_IN}=${input}`], { stdio: 'pipe' });
  return name;
};

const port = 8600 + Math.floor(Math.random() * 400);
let serve, br;
const stop = (code) => { try { serve?.kill(); } catch {} try { br?.close(); } catch {}
                         try { rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(code); };
try {
  const pages = { small: packFor(SMALL, 'small.html'), big: packFor(BIG, 'big.html') };
  serve = spawn(process.execPath, [join(here, '..', 'tools', 'gui', 'serve.mjs'), dir, String(port)], { stdio: 'ignore' });
  br = await openBrowser();
  const TIMEOUT_S = +(process.env.VSPAGE_TIMEOUT || 600);
  const pageOnce = async (name) => {
    await br.navigate(`http://127.0.0.1:${port}/${name}?t=${Math.random()}`);
    const code = await waitForExit(br.q, TIMEOUT_S);
    if (code === null) { console.log(`FAIL: ${name} did not exit within ${TIMEOUT_S}s`); stop(1); }
    if (code !== 0) console.log(`  note: ${name} exited ${code}`);
    return await br.q('window.__oxMs');
  };
  const out = {};
  for (const which of ['small', 'big']) {
    const page = [], nat = [];
    const input = which === 'big' ? BIG : SMALL;
    for (let i = 0; i < REPS; i++) { page.push(await pageOnce(pages[which])); nat.push(nativeOnce(input)); }
    out[which] = { page: median(page), nat: median(nat), bytes: statSync(input).size };
    console.log(`  ${which.padEnd(5)} ${out[which].bytes}B  page ${out[which].page.toFixed(0)}ms  native ${out[which].nat.toFixed(2)}ms  (${REPS} reps, medians)`);
  }
  const dPage = out.big.page - out.small.page, dNat = out.big.nat - out.small.nat;
  const dBytes = out.big.bytes - out.small.bytes;
  console.log(`\n  steady state over ${dBytes}B of extra input:`);
  console.log(`    page   ${dPage.toFixed(0)}ms`);
  console.log(`    native ${dNat.toFixed(2)}ms`);
  // A subtraction of two noisy medians can come out negative or near zero, at
  // which point the ratio is not a measurement of anything. Say so instead of
  // printing a number.
  if (dNat <= 0 || dPage <= 0)
    console.log(`\n  RESULT unusable: the two sizes did not separate (page ${dPage.toFixed(0)}ms, native ${dNat.toFixed(2)}ms) — widen the gap between --big and --small`);
  else
    console.log(`\n  RESULT ${(dPage / dNat).toFixed(1)}x native, in the browser, steady state`);
  console.log(`  (page floor, all of load+tier: ${out.small.page.toFixed(0)}ms at ${out.small.bytes}B)`);
  stop(0);
} catch (e) { console.log(`FAIL: ${e.message}`); stop(1); }

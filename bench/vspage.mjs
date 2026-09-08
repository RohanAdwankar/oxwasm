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
//        [--runs 3] -- /bin/gzip -9 -c {IN}
//
// --runs repeats the WHOLE two-size measurement and reports the spread across
// repeats. That is not the same noise --reps measures, and the difference is
// not academic: comparing two engine trees on the same box, one run reported
// 424 +- 57 ms where two others of the same tree read 246 and 278. It passed
// its own 3-sigma gate at 7.4 sigma and was still an outlier, because the
// within-run error bar does not see whatever the machine does BETWEEN runs.
// A single run's interval is a lower bound on the uncertainty, not the
// uncertainty.
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
const BIG = opt('big'), SMALL = opt('small'), REPS = Number(opt('reps', 3)), RUNS = Number(opt('runs', 1));
const GUEST_IN = opt('guest-in', '/data/in');
const cmd = argv.slice(dd + 1);
if (!BIG || !SMALL) { console.log('need --big and --small'); process.exit(1); }
const bin = cmd[0], args = cmd.slice(1);
const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];

// Native side: plant the input at the guest path so argv matches, time the
// run, remove it. A guest path that already exists on the host is refused
// rather than clobbered.
//
// stdout is CAPTURED, not sent to /dev/null, because discarding it changes
// what the program does: GNU grep short-circuits when its output goes nowhere,
// and `grep -c` over 41 MB measured 2.2 ms discarded against 34 ms captured.
// The page collects the guest's stdout, so the native side has to produce it
// too or the two are not doing the same work.
const nativeOnce = (input) => {
  if (existsSync(GUEST_IN)) { console.log(`refusing: ${GUEST_IN} already exists on the host`); process.exit(1); }
  mkdirSync(dirname(GUEST_IN), { recursive: true }); copyFileSync(input, GUEST_IN);
  const t0 = process.hrtime.bigint();
  let code = 0, bytes = 0, hash = '';
  const digest = (b) => { let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < b.length; i++) { h1 = Math.imul(h1 ^ b[i], 0x01000193) >>> 0; h2 = Math.imul(h2 + b[i], 0x85ebca6b) >>> 0; }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'); };
  try { const out = execFileSync(bin, args.map(a => a.replace('{IN}', GUEST_IN)), { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 });
        bytes = out.length; hash = digest(out); }
  catch (e) { code = e.status ?? -1; const out = e.stdout ?? Buffer.alloc(0); bytes = out.length; hash = digest(out); }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  try { unlinkSync(GUEST_IN); } catch {}
  return { ms, code, bytes, hash };
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
    return { ms: await br.q('window.__oxMs'), hash: await br.q('window.__oxOutHash'),
             asmMs: await br.q('window.__oxAsmMs || 0'), asmN: await br.q('window.__oxAsmN || 0') };
  };
  const runs = [];
  for (let run = 0; run < RUNS; run++) {
  if (RUNS > 1) console.log(`\n  run ${run + 1} of ${RUNS}`);
  const out = {};
  for (const which of ['small', 'big']) {
    const page = [], nat = [], asm = []; let asmN = 0;
    const input = which === 'big' ? BIG : SMALL;
    let natCode = 0, natBytes = 0;
    // A benchmark that never checks the answer can be timing anything at all.
    // The page reports a digest over its raw stdout and the native side takes
    // the same one, so a ratio is only printed when both produced the same
    // bytes.
    for (let i = 0; i < REPS; i++) {
      const p = await pageOnce(pages[which]);
      page.push(p.ms); asm.push(p.asmMs); asmN = p.asmN;
      const r = nativeOnce(input); nat.push(r.ms); natCode = r.code; natBytes = r.bytes;
      if (p.hash !== r.hash) {
        console.log(`FAIL: ${which} output differs from native (page ${p.hash} vs native ${r.hash}) — timing a wrong answer`);
        stop(1);
      }
    }
    // A program that exits nonzero has usually stopped early and timed nothing
    // worth comparing: `sort -c` on unsorted input quits at the second line, so
    // both sizes read the same few milliseconds of process spawn.
    if (natCode !== 0) { console.log(`  ${which}: native exited ${natCode} — it did not run to completion, so there is nothing to time`); stop(1); }
    // standard error, not max-minus-min: the range is a biased noise estimate
    // that grows with the number of samples, so more reps would make a good
    // measurement look worse. The error on a median of n falls as sqrt(n),
    // which is what more reps are for.
    const stderr = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length;
      return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1)) / Math.sqrt(a.length); };
    out[which] = { page: median(page), nat: median(nat), pageErr: stderr(page), natErr: stderr(nat), bytes: statSync(input).size,
                   asm: median(asm), asmN };
    console.log(`  ${which.padEnd(5)} ${out[which].bytes}B  page ${out[which].page.toFixed(0)}±${out[which].pageErr.toFixed(0)}ms  ` +
                `native ${out[which].nat.toFixed(2)}±${out[which].natErr.toFixed(2)}ms  (${REPS} reps, medians ± standard error)`);
  }
  const dPage = out.big.page - out.small.page, dNat = out.big.nat - out.small.nat;
  const dBytes = out.big.bytes - out.small.bytes;
  runs.push({ dPage, dNat, dBytes, floor: out.small.page, bytes: out.small.bytes,
              pageErr: Math.hypot(out.big.pageErr, out.small.pageErr),
              natErr: Math.hypot(out.big.natErr, out.small.natErr) });
  // The subtraction carries both runs' noise, so the difference is only a
  // measurement if it is large against that noise. A positive difference is
  // not enough on its own: at a narrow size gap this reported 41.9x where a
  // 15x wider gap on the same binary read 7.1x, because the narrow one was
  // measuring the floor's jitter and whatever tiering had not finished.
  // errors add in quadrature across the subtraction
  const pageNoise = Math.hypot(out.big.pageErr, out.small.pageErr);
  const natNoise = Math.hypot(out.big.natErr, out.small.natErr);
  console.log(`\n  steady state over ${dBytes}B of extra input:`);
  console.log(`    page   ${dPage.toFixed(0)} ± ${pageNoise.toFixed(0)}ms`);
  console.log(`    native ${dNat.toFixed(2)} ± ${natNoise.toFixed(2)}ms`);
  if (dNat <= 0 || dPage <= 0)
    console.log(`\n  RESULT unusable: the two sizes did not separate (page ${dPage.toFixed(0)}ms, native ${dNat.toFixed(2)}ms) — widen the gap between --big and --small`);
  else if (dPage < 3 * pageNoise || dNat < 3 * natNoise)
    console.log(`\n  RESULT unreliable: ${(dPage / dNat).toFixed(1)}x, but the difference is not 3x its own noise ` +
                `(page ${dPage.toFixed(0)}±${pageNoise.toFixed(0)}, native ${dNat.toFixed(2)}±${natNoise.toFixed(2)}) — widen the size gap or raise --reps`);
  else {
    // worst case in each direction, so the range is the measurement's own
    const lo = (dPage - pageNoise) / (dNat + natNoise), hi = (dPage + pageNoise) / (dNat - natNoise);
    console.log(`\n  RESULT ${(dPage / dNat).toFixed(1)}x native, in the browser, steady state (${lo.toFixed(1)}–${hi.toFixed(1)}x at one standard error)`);
  }
  console.log(`  (page floor, all of load+tier: ${out.small.page.toFixed(0)}ms at ${out.small.bytes}B` +
              (out.small.asmN ? `, of which ${out.small.asm.toFixed(0)}ms is in-page wabt over ${out.small.asmN} units` : '') + `)`);
  }
  if (RUNS > 1) {
    // Between-run spread. Whichever noise is LARGER is the honest one, so the
    // summary below takes the max rather than the flattering one.
    const sp = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length;
      return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1)) / Math.sqrt(a.length); };
    const dps = runs.map(r => r.dPage), dns = runs.map(r => r.dNat);
    const mp = median(dps), mn = median(dns);
    const betweenP = sp(dps), betweenN = sp(dns);
    const withinP = median(runs.map(r => r.pageErr)), withinN = median(runs.map(r => r.natErr));
    console.log(`\n  ACROSS ${RUNS} RUNS`);
    console.log(`    page   steady state per run: ${dps.map(v => v.toFixed(0)).join(', ')} ms`);
    console.log(`    native steady state per run: ${dns.map(v => v.toFixed(2)).join(', ')} ms`);
    console.log(`    page   median ${mp.toFixed(0)}ms  within-run +-${withinP.toFixed(0)}  between-run +-${betweenP.toFixed(0)}`);
    console.log(`    native median ${mn.toFixed(2)}ms  within-run +-${withinN.toFixed(2)}  between-run +-${betweenN.toFixed(2)}`);
    const noiseP = Math.max(withinP, betweenP), noiseN = Math.max(withinN, betweenN);
    if (mn <= 0 || mp <= 0) console.log(`\n  RESULT unusable: the two sizes did not separate`);
    else if (mp < 3 * noiseP || mn < 3 * noiseN)
      console.log(`\n  RESULT unreliable: ${(mp / mn).toFixed(1)}x, not 3x the LARGER of the two noises ` +
                  `(page ${mp.toFixed(0)}+-${noiseP.toFixed(0)}, native ${mn.toFixed(2)}+-${noiseN.toFixed(2)})`);
    else {
      const lo = (mp - noiseP) / (mn + noiseN), hi = (mp + noiseP) / (mn - noiseN);
      console.log(`\n  RESULT ${(mp / mn).toFixed(1)}x native, in the browser, steady state ` +
                  `(${lo.toFixed(1)}-${hi.toFixed(1)}x at one standard error, the larger of within- and between-run)`);
    }
  }
  stop(0);
} catch (e) { console.log(`FAIL: ${e.message}`); stop(1); }

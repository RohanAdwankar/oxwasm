// End-to-end check of the DYNAMIC glibc lane: an unmodified GNU coreutils
// binary from the host, its real ld.so and shared libraries, running in the
// engine. shelltest covers a static busybox; this covers what that cannot —
// PT_INTERP, ld.so relocation and symbol binding, locale setup, glibc stdio.
// Skips (with a notice) if the host has no suitable binary.
import { LinuxEngine } from '../linux.mjs';
import { readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const files = {}, mtimes = {};
const add = (guest, host) => {
  try { files[guest] = new Uint8Array(readFileSync(host));
        mtimes[guest] = Math.floor(lstatSync(host).mtimeMs / 1000); return true; }
  catch { return false; }
};
for (const d of ['/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu', '/lib64']) {
  let ents; try { ents = readdirSync(d); } catch { continue; }
  for (const f of ents) {
    try { const real = realpathSync(join(d, f));
          if (lstatSync(real).isFile()) add(join(d, f), real); } catch {}
  }
}
add('/etc/ld.so.cache', '/etc/ld.so.cache');

const BIN = ['/usr/bin/sha256sum', '/bin/sha256sum'].find(b => add(b, b));
const WC = ['/usr/bin/wc', '/bin/wc'].find(b => add(b, b));
const isElf64 = (b) => b && b[0] === 0x7f && b[4] === 2 &&
  new DataView(b.buffer, b.byteOffset).getUint16(18, true) === 0x3e;
if (!BIN || !WC || !isElf64(files[BIN]) || !files['/lib64/ld-linux-x86-64.so.2']) {
  console.log('gnutest SKIPPED: no dynamic x86-64 GNU coreutils on this host');
  process.exit(0);
}

// deterministic input, with the expected digest computed here rather than by
// shelling out — the check is the engine's output, not the host's
const DATA = Buffer.from(Array.from({ length: 20000 },
  (_, i) => String.fromCharCode(97 + ((i * 7919) % 26))).join('').replace(/(.{40})/g, '$1\n'));
files['/tmp/gnu_in.txt'] = new Uint8Array(DATA);
const wantSum = createHash('sha256').update(DATA).digest('hex');
const wantLines = DATA.toString().split('\n').length - 1;

const run = (bin, args) => {
  const eng = new LinuxEngine(files[bin], { argv: [bin, ...args],
    env: ['LC_ALL=C', 'HOME=/root', 'PATH=/bin'], files, mtimes, memMB: 512 });
  const t0 = Date.now();
  while (eng.exitCode === null && Date.now() - t0 < 180000) { eng.run(5e7); if (eng.blocked) eng.wake(); }
  return { code: eng.exitCode, out: eng.stdout.join(''), err: (eng.stderr ?? []).join('') };
};

let bad = 0;
const sum = run(BIN, ['/tmp/gnu_in.txt']);
if (sum.code !== 0 || sum.out.split(/\s+/)[0] !== wantSum) {
  console.log(`GNUTEST FAIL sha256sum exit=${sum.code} out=${JSON.stringify(sum.out.slice(0, 80))} want=${wantSum}`);
  bad++;
}
const wc = run(WC, ['-l', '/tmp/gnu_in.txt']);
if (wc.code !== 0 || Number(wc.out.trim().split(/\s+/)[0]) !== wantLines) {
  console.log(`GNUTEST FAIL wc -l exit=${wc.code} out=${JSON.stringify(wc.out.slice(0, 80))} want=${wantLines}`);
  bad++;
}
if (bad) process.exit(1);
console.log('dynamic glibc lane (GNU coreutils: ld.so, relocation, stdio) exact');

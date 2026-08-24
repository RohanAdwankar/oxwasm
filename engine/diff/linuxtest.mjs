import { LinuxEngine } from '../linux.mjs';
import { readFileSync } from 'node:fs';
const bin = readFileSync(process.argv[2]);
// any argv entry that is a real host file is mirrored into the guest FS
import { existsSync } from 'node:fs';
const files = {};
for (const a of process.argv.slice(3)) if (existsSync(a)) files[a] = new Uint8Array(readFileSync(a));
const eng = new LinuxEngine(new Uint8Array(bin), { argv: process.argv.slice(2), files });
const t0 = process.hrtime.bigint();
try {
  const r = eng.run();
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  console.log('--- stdout ---'); process.stdout.write(r.stdout);
  console.log('--- exit:', r.exitCode, ` wall: ${secs.toFixed(2)}s ---`);
  console.log('interpreted:', r.stats.interpreted, ' compiled-loop runs:', r.stats.compiledRuns,
              ' tiers:', JSON.stringify(r.stats.tiers));
  console.log('syscalls:', JSON.stringify(r.stats.syscalls), eng.unknown ? ' UNKNOWN: '+[...eng.unknown] : '');
} catch (e) {
  console.log('FAULT at rip', e.rip?.toString(16), ':', e.message);
  // dump bytes at rip for diagnosis
  if (e.rip) {
    const b = [];
    for (let i = 0n; i < 15n; i++) { try { b.push(Number(eng.mem.read(e.rip + i, 1n)).toString(16).padStart(2,'0')); } catch {} }
    console.log('bytes:', b.join(' '));
  }
}

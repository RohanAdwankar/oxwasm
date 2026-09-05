// Deterministic form of the page-recycle race the deferred assembler opened
// (tools/fixtures/recycle.asm): code A tiers up on an rwx page; the guest
// munmaps the page and maps code B there. A unit still in the assembler's
// queue at the munmap must NOT register when it lands - it would put A's
// translation over B's page and the guest would print A. Here every unit is
// held until the guest's munmap is seen in the syscall trace, then delivered.
import { LinuxEngine } from '../linux.mjs';
import { makeAssembler } from '../../tools/assemble.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'recycle-'));
const bin = join(dir, 'recycle');
execFileSync('nasm', ['-f', 'bin', '-o', bin, new URL('../../tools/fixtures/recycle.asm', import.meta.url).pathname]);
const asm = makeAssembler({ tag: 'rct' });

const run = (holdUntilMunmap) => {
  const eng = new LinuxEngine(new Uint8Array(readFileSync(bin)), { argv: ['recycle'], env: [], files: {}, mtimes: {}, memMB: 256, assembleWat: asm });
  eng.strace = [];
  eng.onAotFail = (a, m) => console.log('aotfail', a.toString(16), String(m).slice(0, 300));
  const held = [];
  eng.assembleWatDeferred = (wat, cb) => { held.push([wat, cb]); };
  let delivered = 0;
  const deliver = () => { while (held.length) { delivered++; const [wat, cb] = held.shift(); let b = null, e = null; try { b = asm(wat); } catch (x) { e = x; } cb(b, e); } };
  let munmapped = false;
  eng.pumpAsm = () => {
    // the window is after the munmap AND the mmap that recycles the page (a
    // MAP_FIXED overlay drops translations too), before the call into it
    if (!munmapped) { const i = eng.strace.findIndex(l => /\]11\(600000,/.test(l)); munmapped = i >= 0 && eng.strace.slice(i + 1).some(l => /\]9\(600000,/.test(l)); }
    if (munmapped || !holdUntilMunmap) deliver();
  };
  // Small slices once the page is gone: the pump at each run() start must land
  // inside the window between the munmap and the guest's call into the new
  // code, which is a dozen instructions wide.
  let guard = 0;
  while (eng.exitCode === null && guard++ < 5e6) { eng.run(munmapped ? 3 : 2e5); if (!munmapped) eng.pumpAsm(); }
  const out = Buffer.from((eng.stdout || []).join(''), 'binary').toString();
  if (process.env.DBG) console.log({ delivered, held: held.length, munmapped, aot: eng.aotFns.size, aotRuns: eng.stats.aotRuns, interp: eng.stats.interpreted, calls: [...eng.aotCalls.entries()].map(([k, v]) => k.toString(16) + ':' + v), tail: eng.strace.slice(-6) });
  return { out, units: held.length, exit: eng.exitCode };
};

const r0 = run(false), r1 = run(true);
const ok = r0.out === 'B\n' && r1.out === 'B\n';
console.log(`recycle: prompt delivery -> ${JSON.stringify(r0.out)}, delivery held past munmap -> ${JSON.stringify(r1.out)}: ${ok ? 'ok' : 'STALE TRANSLATION'}`);
process.exit(ok ? 0 : 1);

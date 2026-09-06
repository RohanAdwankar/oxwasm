// Re-exec the current node entry point with the V8 heap flags the translator
// wants. The translator is allocation-heavy (rustc-asm builds 790 MB of wat
// text over 5,500 units, each instruction an object with BigInt fields) and
// node's default 16 MB semi-space made the scavenger 24% of that run: 44 s of
// 181. --max-semi-space-size=128 reads 11 s (64 MB: 17 s). The flag only
// takes effect on the command line - v8.setFlagsFromString() after startup
// measured no change - so a host that wants it re-executes itself once, with
// its own execArgv (--expose-gc, --cpu-prof, ...) kept and the flag added.
// OXWASM_NO_REEXEC=1 opts out (a debugger attached to the first process).
import { spawnSync } from 'node:child_process';

export const HEAP_FLAGS = ['--max-semi-space-size=128'];

export function ensureHeapFlags() {
  if (process.env.OXWASM_NO_REEXEC === '1') return;
  if (process.execArgv.some(a => a.startsWith('--max-semi-space-size'))) return;
  if ((process.env.NODE_OPTIONS || '').includes('--max-semi-space-size')) return;
  const r = spawnSync(process.execPath, [...process.execArgv, ...HEAP_FLAGS, ...process.argv.slice(1)],
    { stdio: 'inherit', env: { ...process.env, OXWASM_NO_REEXEC: '1' } });
  process.exit(r.status === null ? 1 : r.status);
}

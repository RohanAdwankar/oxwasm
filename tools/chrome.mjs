// Where headless Chromium is.
//
// Every browser probe spawned '/opt/pw-browsers/chromium' by name - the path
// one machine happened to have. Anywhere else the spawn fails with ENOENT and
// the probe reports "no browser" (or hangs waiting for a debugger port that
// will never open), which reads like a page bug rather than a missing program.
// OXWASM_CHROME points at a specific binary; otherwise the usual install
// locations and PATH names are tried in order.
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const PATHS = ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser',
               '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
const NAMES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome'];

let memo;
export function chromePath() {
  if (memo !== undefined) return memo;
  const tried = [];
  for (const p of [process.env.OXWASM_CHROME, ...PATHS]) {
    if (!p) continue;
    tried.push(p);
    if (existsSync(p)) return (memo = p);
  }
  for (const n of NAMES) {
    tried.push(n);
    try { const p = execFileSync('sh', ['-c', `command -v ${n}`], { encoding: 'utf8' }).trim();
          if (p) return (memo = p); } catch {}
  }
  throw new Error(`headless Chromium not found (tried ${tried.join(', ')}); set OXWASM_CHROME to its path`);
}

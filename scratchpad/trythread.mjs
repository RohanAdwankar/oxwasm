import { LinuxEngine } from '../engine/linux.mjs';
import { readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
const files = {}, mtimes = {};
const add = (g, h = g) => { try { files[g] = new Uint8Array(readFileSync(h)); mtimes[g] = 1; } catch {} };
for (const d of ['/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu', '/lib64']) {
  let e; try { e = readdirSync(d); } catch { continue; }
  for (const f of e) { try { const r = realpathSync(join(d, f)); if (lstatSync(r).isFile()) add(join(d, f), r); } catch {} }
}
add('/etc/ld.so.cache');
add('/tmp/thr');
const eng = new LinuxEngine(new Uint8Array(readFileSync('/tmp/thr')),
  { argv: ['/tmp/thr'], env: ['PATH=/usr/bin', 'HOME=/root', 'LANG=C'], files, mtimes, memMB: 512 });
let err = null, guard = 0;
const t0 = Date.now();
try { while (eng.exitCode === null) { eng.run(5e7); if (eng.blocked) eng.wake(); if (++guard > 20000) { err='no exit'; break; } } }
catch (e) { err = e.message; }
console.log('code:', eng.exitCode, 'err:', err, 'ms:', Date.now()-t0);
console.log('stdout:', JSON.stringify((eng.stdoutBytes&&eng.stdoutBytes.length?Buffer.concat(eng.stdoutBytes.map(b=>Buffer.from(b))):Buffer.from((eng.stdout||[]).join(''),'binary')).toString()));
if (eng.stderr&&eng.stderr.length) console.log('stderr:', eng.stderr.join('').slice(0,300));

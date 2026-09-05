// A curses/full-screen app on a pty. This is the raw-mode half of the line
// discipline: less and nano clear ICANON and ECHO, read single keystrokes,
// and drive the screen with terminfo escape sequences. No X involved — the
// pty slave IS stdin/stdout/stderr, and we type at the master.
import { LinuxEngine } from '../../engine/linux.mjs';
import { readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const files = {}, mtimes = {};
const add = (g, h) => { try { files[g] = new Uint8Array(readFileSync(h)); mtimes[g] = 0; } catch {} };
for (const d of ['/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu', '/lib64']) {
  let e; try { e = readdirSync(d); } catch { continue; }
  for (const f of e) { try { const r = realpathSync(join(d, f)); if (lstatSync(r).isFile()) add(join(d, f), r); } catch {} } }
add('/etc/ld.so.cache', '/etc/ld.so.cache');
// terminfo: a curses app cannot address the screen without its terminal's entry
(function walk(d, g) { let e; try { e = readdirSync(d); } catch { return; }
  for (const f of e) { const hp = join(d, f), gp = g + '/' + f; let st;
    try { st = lstatSync(hp); } catch { continue; }
    if (st.isDirectory()) walk(hp, gp); else { try { add(gp, realpathSync(hp)); } catch {} } }
})('/usr/share/terminfo', '/usr/share/terminfo');

const bin = process.argv[2] || '/usr/bin/less';
const keys = process.argv[3] ?? 'q';
add(bin, bin);
if (!files[bin]) { console.log('absent:', bin); process.exit(0); }
files['/data/doc.txt'] = new TextEncoder().encode(
  Array.from({ length: 40 }, (_, i) => `line ${i} the quick brown fox`).join('\n') + '\n');

const eng = new LinuxEngine(files[bin], {
  argv: [bin, '/data/doc.txt'],
  env: ['TERM=xterm', 'PATH=/bin:/usr/bin', 'HOME=/root', 'LANG=C', 'LINES=24', 'COLUMNS=80'],
  files, mtimes, memMB: 256, tty: true });

// stdin/stdout/stderr ARE the pty slave, so the app sees a real terminal and
// we can type at the master.
const pty = eng.newPty();
const slave = eng.ptsHandle(pty), master = eng.ptmxHandle(pty);
for (const fd of [0, 1, 2]) eng.fds.set(fd, slave);

const out = [];
const push0 = pty.s2m.chunks.push.bind(pty.s2m.chunks);
pty.s2m.chunks.push = (...xs) => { for (const c of xs) out.push(...c); return push0(...xs); };

const step = (ms) => { const t = Date.now();
  while (eng.exitCode === null && Date.now() - t < ms) { eng.run(2e7); if (eng.blocked) eng.wake(); } };

step(25000);                                              // let it draw its first screen
const screen1 = out.length;
const T = pty.termios;
console.log(`after first draw: ${out.length} bytes out, ICANON=${!!(T.lflag & 2)} ECHO=${!!(T.lflag & 8)}`);

for (const ch of keys) { eng.ttyInput(pty, new Uint8Array([ch.charCodeAt(0)])); step(4000); }
step(6000);

const text = new TextDecoder().decode(new Uint8Array(out));
console.log(`exit=${eng.exitCode} total=${out.length} bytes (${out.length - screen1} after keys)`);
console.log('escapes:', (text.match(/\x1b\[[0-9;]*[A-Za-z]/g) || []).length,
            ' printable sample:', JSON.stringify(text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[^\x20-\x7e\n]/g, '').slice(0, 160)));
console.log('stderr:', (eng.stderr || []).join('').slice(0, 200));

// The terminal lane. ioctl used to return ENOTTY for everything, so an
// interactive shell printed "can't access tty; job control turned off",
// tty(1) printed "not a tty", and stty(1) failed outright.
//
// Three things have to agree or glibc rejects the terminal:
//   - TCGETS fills the *kernel* struct termios (36 bytes, c_cc[19]).  glibc's
//     60-byte user struct has c_ispeed/c_ospeed appended; writing that many
//     bytes smashes the caller's stack canary.
//   - getpgrp/getpgid/setpgid must be consistent with TIOCGPGRP, or dash's
//     `while (getpgrp() != tcgetpgrp(fd))` loop never converges.
//   - ttyname() readlinks /proc/self/fd/N and stats the answer, comparing
//     st_rdev/st_ino with the fd's fstat.  stat, lstat, fstat and newfstatat
//     all have to report the same char device.
import { LinuxEngine } from '../linux.mjs';
import { readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const files = {}, mtimes = {};
const add = (g, h) => { try { files[g] = new Uint8Array(readFileSync(h)); mtimes[g] = 0; } catch {} };
for (const d of ['/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu', '/lib64']) {
  let e; try { e = readdirSync(d); } catch { continue; }
  for (const f of e) { try { const r = realpathSync(join(d, f)); if (lstatSync(r).isFile()) add(join(d, f), r); } catch {} }
}
add('/etc/ld.so.cache', '/etc/ld.so.cache');
for (const b of ['/bin/dash', '/usr/bin/tty', '/usr/bin/stty']) add(b, b);

const run = (argv) => {
  const eng = new LinuxEngine(files[argv[0]], { argv, env: ['PATH=/bin:/usr/bin', 'TERM=xterm', 'HOME=/root'],
    files: { ...files }, mtimes, memMB: 256, tty: true });
  let ioctls = 0;
  const old = eng.syscall.bind(eng);
  eng.syscall = (cpu) => { if (Number(cpu.regs[0] & 0xffffffffn) === 16) ioctls++; return old(cpu); };
  const t0 = Date.now();
  try { while (eng.exitCode === null && Date.now() - t0 < 60000) { eng.run(5e7); if (eng.blocked) eng.wake(); } } catch {}
  return { exit: eng.exitCode, out: eng.stdout.join(''), err: (eng.stderr || []).join(''), ioctls };
};

let fail = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('  ' + name + ' ok');
  else { console.log('  ' + name + ' FAIL ' + detail); fail++; }
};

if (!files['/bin/dash'] || !files['/usr/bin/tty'] || !files['/usr/bin/stty']) {
  console.log('ttytest SKIPPED: no dash/tty/stty on this host');
  process.exit(0);
}

// A terminal-less engine must still say ENOTTY rather than pretend one exists.
{
  const bare = new LinuxEngine(files['/bin/dash'], { argv: ['dash'], files: { ...files }, memMB: 32 });
  check('no-tty engine claims no terminal', bare.isTtyPath('/dev/tty') === false, '(isTtyPath true without tty)');
  const eng = new LinuxEngine(files['/bin/dash'], { argv: ['dash'], files: { ...files }, memMB: 32, tty: true });
  const ok = eng.isTtyPath('/dev/tty') && eng.isTtyPath('/dev/pts/0') && eng.isTtyPath('/dev/console')
          && !eng.isTtyPath('/dev/null') && !eng.isTtyPath('/etc/passwd');
  check('tty device names resolve', ok, '(isTtyPath misclassified)');
}

// Job control: the shell must not fall back to "can't access tty", and must
// not spin on TIOCGPGRP (the unconverged loop billed 1.28M ioctls).
{
  const r = run(['/bin/dash', '-i', '-c', 'echo hi']);
  check('dash -i takes job control', r.exit === 0 && r.out === 'hi\n' && !/can't access tty/.test(r.err),
        `exit=${r.exit} out=${JSON.stringify(r.out)} err=${JSON.stringify(r.err.slice(0, 80))}`);
  check('dash -i does not spin on TIOCGPGRP', r.ioctls < 1000, `${r.ioctls} ioctls`);
}

// ttyname(): the stat-consistency path.
{
  const r = run(['/usr/bin/tty']);
  check('tty(1) names the terminal', r.exit === 0 && r.out === '/dev/pts/0\n',
        `exit=${r.exit} out=${JSON.stringify(r.out)}`);
}

// TCGETS/TIOCGWINSZ, and the stack canary that a 60-byte write trips.
{
  const r = run(['/usr/bin/stty', '-a']);
  check('stty -a reads termios', r.exit === 0 && /rows 24; columns 80/.test(r.out),
        `exit=${r.exit} out=${JSON.stringify(r.out.slice(0, 80))}`);
  check('TCGETS does not smash the stack', !/stack smashing/.test(r.err), r.err.slice(0, 80));
}

if (fail) { console.log(`TTYTEST ${fail} FAILED`); process.exit(1); }
console.log('terminal lane: job control, ttyname, termios exact');

// A vfork child runs in the PARENT's address space, so everything it writes
// has to be undone when it execs. Its own stores go through this.mem and are
// journaled — but a syscall writes its RESULT straight into guest memory,
// which the journal never saw. That left a child's struct stat, termios,
// readlink path or read() buffer permanently on the parent's stack.
//
// Two of those were real crashes: TCGETS overwrote the parent's stack canary
// ("*** stack smashing detected ***") and readlink wrote "/dev/pts/0" over a
// return address (the engine faulted to 0x7374702f76656447, that path in
// hex). The rest were latent. This pins the whole class: for each syscall,
// scribble a known pattern, run it with a journal armed, roll back, and the
// memory must be byte-identical again.
import { LinuxEngine } from '../linux.mjs';
import { readFileSync } from 'node:fs';

let elf;
for (const b of ['/bin/dash', '/bin/busybox', '/bin/cat']) {
  try { elf = new Uint8Array(readFileSync(b)); break; } catch {}
}
if (!elf) { console.log('jrnltest SKIPPED: no binary to build an engine from'); process.exit(0); }
const files = {};
for (const p of ['/lib64/ld-linux-x86-64.so.2', '/lib/x86_64-linux-gnu/libc.so.6'])
  { try { files[p] = new Uint8Array(readFileSync(p)); } catch {} }
files['/data/f.txt'] = new TextEncoder().encode('x'.repeat(300));
let eng;
try { eng = new LinuxEngine(elf, { argv: ['x'], files, memMB: 64, tty: true }); }
catch (e) { console.log('jrnltest SKIPPED: ' + e.message); process.exit(0); }

let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log('  ' + name + ' ok');
  else { console.log('  ' + name + ' FAIL ' + detail); fail++; }
};

const SCRATCH = eng.cpu.regs[4] - 16384n;                 // well below the stack
const AREA = 512;
const poison = (n) => (n * 7 + 11) & 0xff;

// Run one syscall with a journal armed, then undo it exactly as
// _vforkRollback does, and report whether the region came back.
const roundTrip = (nr, a1, a2, a3, a4) => {
  for (let i = 0; i < AREA; i++) eng.mem.write(SCRATCH + BigInt(i), 1n, BigInt(poison(i)));
  const before = eng.mem.view(SCRATCH, BigInt(AREA)).slice();
  const jr = [];
  eng.mem.jrnl = jr;
  const c = eng.cpu, save = [c.regs[0], c.regs[7], c.regs[6], c.regs[2], c.regs[10]];
  c.regs[0] = BigInt(nr); c.regs[7] = a1; c.regs[6] = a2; c.regs[2] = a3; c.regs[10] = a4 ?? 0n;
  try { eng.syscall(c); } catch {}
  const rv = BigInt.asIntN(64, c.regs[0]);
  [c.regs[0], c.regs[7], c.regs[6], c.regs[2], c.regs[10]] = save;
  eng.mem.jrnl = null;
  const dirty = !eng.mem.view(SCRATCH, BigInt(AREA)).every((v, i) => v === before[i]);
  for (let i = jr.length - 1; i >= 0; i--) {                // the rollback
    const [a, n, old, snap] = jr[i];
    try { if (snap) eng.mem.view(a, BigInt(snap.length)).set(snap); else eng.mem.write(a, n, old); } catch {}
  }
  const after = eng.mem.view(SCRATCH, BigInt(AREA));
  return { restored: after.every((v, i) => v === before[i]), dirty, rv, entries: jr.length };
};

// A path in guest memory for the syscalls that need one
const PATHBUF = SCRATCH - 4096n;
const putPath = (s) => { const b = new TextEncoder().encode(s + '\0');
  b.forEach((ch, i) => eng.mem.write(PATHBUF + BigInt(i), 1n, BigInt(ch))); return PATHBUF; };

const fd = eng.allocFd();
eng.fds.set(fd, { bytes: files['/data/f.txt'], pos: 0, path: '/data/f.txt' });

const cases = [
  ['stat writes struct stat',   4,   putPath('/data/f.txt'), SCRATCH, 0n],
  ['newfstatat writes it too',  262, -100n, putPath('/data/f.txt'), SCRATCH],
  ['read fills the buffer',     0,   BigInt(fd), SCRATCH, 200n],
  ['uname fills utsname',       63,  SCRATCH, 0n, 0n],
  ['getcwd writes the path',    79,  SCRATCH, 256n, 0n],
  ['TCGETS writes termios',     16,  0n, 0x5401n, SCRATCH],
  ['TIOCGWINSZ writes winsize', 16,  0n, 0x5413n, SCRATCH],
  ['pipe writes two fds',       22,  SCRATCH, 0n, 0n],
];
for (const [name, nr, a1, a2, a3, a4] of cases) {
  const r = roundTrip(nr, a1, a2, a3, a4);
  // A case that never wrote anything proves nothing — flag it rather than
  // let it pass as a green tick.
  if (!r.dirty) check(name, false, `(syscall wrote nothing, rv=${r.rv} — test is vacuous)`);
  else check(name, r.restored, `rv=${r.rv} journal entries=${r.entries}`);
}

// readlink of /proc/self/fd/N is the one that wrote a path over a return
// address, so it gets its own case against a tty fd.
{
  const tfd = eng.allocFd();
  eng.fds.set(tfd, { sink: 'out', istty: true, path: '/dev/pts/0' });
  const r = roundTrip(89, putPath('/proc/self/fd/' + tfd), SCRATCH, 64n, 0n);
  if (!r.dirty) check('readlink writes the tty path', false, `(wrote nothing, rv=${r.rv} — vacuous)`);
  else check('readlink writes the tty path', r.restored, `rv=${r.rv} entries=${r.entries}`);
}

if (fail) { console.log(`JRNLTEST ${fail} FAILED`); process.exit(1); }
console.log('vfork journal: syscall writes are undone with the child\'s own stores');

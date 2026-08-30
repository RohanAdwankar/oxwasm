// Pseudo-terminal pairs. The single fake terminal the tty lane added is
// enough for isatty()/ttyname()/job control, but not for anything that
// ALLOCATES a terminal — xterm, script(1), openpty/forkpty — which needs a
// real master/slave pair with data crossing between the two ends.
//
// A pty here is two pipe buffers crossed: master writes land on the slave's
// read side (the keyboard) and slave writes land on the master's read side
// (the screen). Both ends share one termios, so a TCSETS through either is
// visible to the other.
import { LinuxEngine } from '../linux.mjs';
import { readFileSync } from 'node:fs';

let bb;
try { bb = new Uint8Array(readFileSync('/bin/busybox')); } catch {}
if (!bb || bb[4] !== 2) { bb = null; }
// The pty machinery is engine-level, so drive it directly; a guest binary is
// only needed to construct an engine at all.
let elf = bb;
if (!elf) { try { elf = new Uint8Array(readFileSync('/bin/dash')); } catch {} }
if (!elf) { console.log('ptytest SKIPPED: no binary to build an engine from'); process.exit(0); }

const files = {};
try { files['/lib64/ld-linux-x86-64.so.2'] = new Uint8Array(readFileSync('/lib64/ld-linux-x86-64.so.2')); } catch {}
try { files['/lib/x86_64-linux-gnu/libc.so.6'] = new Uint8Array(readFileSync('/lib/x86_64-linux-gnu/libc.so.6')); } catch {}
let eng;
try { eng = new LinuxEngine(elf, { argv: ['x'], files, memMB: 64, tty: true }); }
catch (e) { console.log('ptytest SKIPPED: ' + e.message); process.exit(0); }

let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log('  ' + name + ' ok');
  else { console.log('  ' + name + ' FAIL ' + detail); fail++; }
};
const dec = (b) => new TextDecoder().decode(b);
const drain = (buf) => { const out = []; while (buf.chunks.length) out.push(...buf.chunks.shift()); buf.off = 0;
                         return dec(new Uint8Array(out)); };

const pty = eng.newPty();
const m = eng.ptmxHandle(pty), sl = eng.ptsHandle(pty);

check('master and slave are distinct ends', m.pipe === sl.wpipe && m.wpipe === sl.pipe,
      '(the two ends are not crossed)');
check('both ends share one termios', m.ptm.termios === sl.pts.termios, '(separate termios)');

// Everything below goes through the real write(2) syscall, not a
// reimplementation of the line discipline in the test.
const scratch = eng.cpu.regs[4] - 8192n;
const writeFd = (h, str) => {
  const fd = eng.allocFd(); eng.fds.set(fd, h);
  const bytes = new TextEncoder().encode(str);
  bytes.forEach((b, i) => eng.mem.write(scratch + BigInt(i), 1n, BigInt(b)));
  const c = eng.cpu;
  const save = [c.regs[0], c.regs[7], c.regs[6], c.regs[2]];
  c.regs[0] = 1n; c.regs[7] = BigInt(fd); c.regs[6] = scratch; c.regs[2] = BigInt(bytes.length);
  eng.syscall(c);
  const rv = BigInt.asIntN(64, c.regs[0]);
  [c.regs[0], c.regs[7], c.regs[6], c.regs[2]] = save;
  eng.fds.delete(fd);
  return rv;
};

// Program output: OPOST|ONLCR must turn a bare \n into \r\n, which is what
// makes a terminal's next line start at column 0.
{
  const p = eng.newPty(), mm = eng.ptmxHandle(p), ss = eng.ptsHandle(p);
  writeFd(ss, 'hi\nthere\n');
  check('ONLCR expands LF to CRLF on output', drain(mm.pipe) === 'hi\r\nthere\r\n',
        JSON.stringify(drain(mm.pipe)));
  p.termios.oflag &= ~4;                                      // ONLCR off -> raw
  writeFd(ss, 'raw\n');
  check('ONLCR off passes LF through', drain(mm.pipe) === 'raw\n', '(still expanded)');
}

// A second pty must be independent of the first — a shared buffer would make
// two terminals echo each other.
{
  const p2 = eng.newPty();
  check('ptys are independent', p2.n !== pty.n && p2.m2s !== pty.m2s && p2.termios !== pty.termios,
        `n=${p2.n} vs ${pty.n}`);
}

// ECHO: bytes written to the master come back out the master's read side, so
// a terminal shows what was typed. With ECHO cleared they must not.
{
  const p3 = eng.newPty(), mm = eng.ptmxHandle(p3), ss = eng.ptsHandle(p3);
  writeFd(mm, 'ls\n');
  check('master writes reach the slave', drain(ss.pipe) === 'ls\n', '(slave saw nothing)');
  check('ECHO returns typed bytes to the master', drain(mm.pipe) === 'ls\n', '(no echo)');
  p3.termios.lflag &= ~8;                                     // ECHO off
  writeFd(mm, 'x\n');
  check('ECHO off suppresses the echo', drain(mm.pipe) === '' && drain(ss.pipe) === 'x\n', '(echoed anyway)');
}

// Canonical mode (ICANON): a terminal hands the reading program whole LINES,
// not keystrokes, and lets ERASE/KILL edit what is still pending. A shell
// reading its own prompt depends on this — without it every keystroke is a
// separate read and backspace arrives as a literal 0x7f in the command.
{
  const p = eng.newPty(), mm = eng.ptmxHandle(p), ss = eng.ptsHandle(p);
  check('ICANON is on by default', !!(p.termios.lflag & 2), 'lflag=0x' + p.termios.lflag.toString(16));
  writeFd(mm, 'ls -l');
  check('a partial line is not delivered', drain(ss.pipe) === '', '(delivered before Enter)');
  check('but it is echoed as typed', drain(mm.pipe) === 'ls -l', '(no echo while typing)');
  writeFd(mm, '\n');
  check('Enter delivers the whole line at once', drain(ss.pipe) === 'ls -l\n', '(line not flushed)');

  // ERASE must edit the pending line and un-draw the character, not echo 0x7f
  writeFd(mm, 'abc');  drain(mm.pipe);
  writeFd(mm, '\x7f');
  check('ERASE un-draws rather than echoing 0x7f', drain(mm.pipe) === '\b \b', JSON.stringify(drain(mm.pipe)));
  writeFd(mm, '\n');
  check('ERASE removed the character from the line', drain(ss.pipe) === 'ab\n', '(erase not applied)');

  // ERASE on an empty line must not erase past the start
  writeFd(mm, '\x7f\x7f'); drain(mm.pipe);
  writeFd(mm, 'z\n');
  check('ERASE stops at the start of the line', drain(ss.pipe) === 'z\n', '(erased past the start)');

  // KILL discards the whole pending line
  writeFd(mm, 'throw away'); drain(mm.pipe);
  writeFd(mm, '\x15');                                       // VKILL = ^U
  writeFd(mm, 'kept\n'); drain(mm.pipe);
  check('KILL discards the pending line', drain(ss.pipe) === 'kept\n', '(kill did not clear)');

  // ICRNL: Enter arrives as CR from a terminal and must become LF
  writeFd(mm, 'cr\r'); drain(mm.pipe);
  check('ICRNL turns CR into LF', drain(ss.pipe) === 'cr\n', '(CR not translated)');

  // Raw mode (ICANON off) must deliver each keystroke immediately — this is
  // what a curses app or a shell in raw mode relies on.
  p.termios.lflag &= ~2;
  writeFd(mm, 'r'); drain(mm.pipe);
  check('raw mode delivers without waiting for Enter', drain(ss.pipe) === 'r', '(buffered in raw mode)');
}

// TIOCGPTN through the real ioctl path must name the slave the master owns.
{
  const p4 = eng.newPty(), mm = eng.ptmxHandle(p4);
  const fd = eng.allocFd(); eng.fds.set(fd, mm);
  const c = eng.cpu;
  const save = [c.regs[0], c.regs[7], c.regs[6], c.regs[2]];
  c.regs[0] = 16n; c.regs[7] = BigInt(fd); c.regs[6] = 0x80045430n; c.regs[2] = scratch;
  eng.syscall(c);
  const rv = BigInt.asIntN(64, c.regs[0]);
  const got = Number(eng.mem.read(scratch, 4n));
  [c.regs[0], c.regs[7], c.regs[6], c.regs[2]] = save;
  eng.fds.delete(fd);
  check('TIOCGPTN names the slave', rv === 0n && got === p4.n, `rv=${rv} n=${got} want ${p4.n}`);
}

// The termios both ends share must be the pty's, not the console's — a pty
// program changing the terminal mode must not reconfigure the session tty.
check('pty termios is not the console termios', pty.termios !== eng.termios, '(shares the console struct)');

if (fail) { console.log(`PTYTEST ${fail} FAILED`); process.exit(1); }
console.log('pty pairs: crossed buffers, shared termios, canonical mode, ERASE/KILL, ECHO, ONLCR exact');

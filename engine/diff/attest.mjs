// *at syscalls with a real directory fd. Modern coreutils open the parent
// directory and then openat the basename — race-safe on a kernel, and a
// lookup of "/basename" if dirfd is ignored (gzip produced nothing and
// reported ENOENT for a file that was present). Uses a static busybox if
// the host has one, since the point is the syscall path, not the binary.
import { LinuxEngine } from '../linux.mjs';
import { readFileSync } from 'node:fs';

let bb;
try { bb = new Uint8Array(readFileSync('/bin/busybox')); } catch {}
if (!bb || bb[4] !== 2 || new DataView(bb.buffer, bb.byteOffset).getUint16(18, true) !== 0x3e) {
  console.log('attest SKIPPED: no static x86-64 /bin/busybox on this host');
  process.exit(0);
}
const files = Object.fromEntries(['busybox', 'sh', 'cat', 'ls'].map(n => ['/bin/' + n, bb]));
files['/data/hello.txt'] = new TextEncoder().encode('at-path ok\n');
const eng = new LinuxEngine(bb, { argv: ['busybox', 'sh', '-c', 'cd /data && cat hello.txt'],
  env: ['PATH=/bin'], files, memMB: 256 });
const t0 = Date.now();
while (eng.exitCode === null && Date.now() - t0 < 120000) { eng.run(5e7); if (eng.blocked) eng.wake(); }

// Direct check of the resolution rule: write a relative path into guest
// memory and resolve it against a directory fd, then against AT_FDCWD.
const e2 = new LinuxEngine(bb, { argv: ['busybox', 'true'], files, memMB: 64 });
const dirfd = e2.allocFd();
e2.fds.set(dirfd, { isdir: true, path: '/data', pos: 0 });
const addr = e2.cpu.regs[4] - 4096n;                 // scratch below the stack
for (const [i, ch] of [...'hello.txt\0'].entries()) e2.mem.write(addr + BigInt(i), 1n, BigInt(ch.charCodeAt(0)));
const viaDir = e2.atPath(BigInt(dirfd), addr);       // must pick up /data
const viaCwd = e2.atPath(-100n, addr);               // AT_FDCWD: left relative
const abs = e2.cpu.regs[4] - 8192n;
for (const [i, ch] of [...'/etc/passwd\0'].entries()) e2.mem.write(abs + BigInt(i), 1n, BigInt(ch.charCodeAt(0)));
const viaAbs = e2.atPath(BigInt(dirfd), abs);        // absolute ignores dirfd
const direct = (viaDir === '/data/hello.txt' && viaCwd === 'hello.txt' && viaAbs === '/etc/passwd')
  ? 'ok' : `bad(${viaDir}|${viaCwd}|${viaAbs})`;

const out = eng.stdout.join('');
if (eng.exitCode === 0 && out === 'at-path ok\n' && direct === 'ok') {
  console.log('*at syscalls resolve against a directory fd (relative openat) exact');
} else {
  console.log('ATTEST FAIL exit=' + eng.exitCode + ' out=' + JSON.stringify(out) + ' direct=' + direct);
  process.exit(1);
}

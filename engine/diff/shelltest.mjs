// End-to-end process-machinery test: an UNMODIFIED static busybox runs a
// POSIX shell script exercising fork/execve/pipes/wait4, command
// substitution, loops into pipelines, file redirection, and subshells.
// Uses the host's /bin/busybox when it is a static x86-64 ELF; skips (with
// a notice) otherwise so the suite stays portable.
import { LinuxEngine } from '../linux.mjs';
import { readFileSync } from 'node:fs';

let bb;
try { bb = new Uint8Array(readFileSync('/bin/busybox')); } catch {}
if (!bb || bb[4] !== 2 || new DataView(bb.buffer, bb.byteOffset).getUint16(18, true) !== 0x3e) {
  console.log('shelltest SKIPPED: no static x86-64 /bin/busybox on this host');
  process.exit(0);
}
const script = 'x=$(echo 5 | tr 5 7); echo got $x; ' +
  'for i in 1 2 3; do echo n$i; done | tr n X; ' +
  'echo hi > /tmp/f && cat /tmp/f; ' +
  '(echo sub; echo shell) | wc -l; ' +
  'echo hello | tr a-z A-Z; echo status $?; ' +
  // runtime-created files must be visible to directory enumeration
  // (find/ls), created dirs must exist, and the LAST command of -c is
  // tail-exec'd by busybox without a fork — each was a real gap
  'find /tmp -name f | wc -l; mkdir -p /tmp/d/dd; echo y > /tmp/d/dd/e; ' +
  'rm /tmp/f; find /tmp/d | sort | tr "\\n" " "; echo; cat /tmp/d/../d/dd/e; ' +
  // cwd (chdir/getcwd), touch (utimensat), and rm -r (rmdir/AT_REMOVEDIR)
  'cd /tmp/d && pwd; touch dd/t && ls dd | sort | tr "\\n" " "; echo; ' +
  'rm -rf /tmp/d/dd && ls /tmp/d | wc -l';
const eng = new LinuxEngine(bb, {
  argv: ['busybox', 'sh', '-c', script],
  env: ['PATH=/bin', 'HOME=/root'],
  files: Object.fromEntries(['busybox', 'sh', 'tr', 'wc', 'cat', 'find', 'ls', 'touch', 'rm', 'mkdir'].map(n => ['/bin/' + n, bb])),
  memMB: 256 });
const t0 = Date.now();
while (eng.exitCode === null && Date.now() - t0 < 120000) { eng.run(5e7); if (eng.blocked) eng.wake(); }
const out = eng.stdout.join('');
const want = 'got 7\nX1\nX2\nX3\nhi\n2\nHELLO\nstatus 0\n1\n' +
  '/tmp/d /tmp/d/dd /tmp/d/dd/e \ny\n/tmp/d\ne t \n0\n';
if (eng.exitCode === 0 && out === want) {
  console.log('shell pipeline (busybox sh: fork/exec/pipes/wait/substitution/redirect) exact');
} else {
  console.log('SHELLTEST FAIL exit=' + eng.exitCode + ' out=' + JSON.stringify(out));
  process.exit(1);
}

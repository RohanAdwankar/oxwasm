// A parent that waits for SIGCHLD the way ash/dash `wait` does - block SIGCHLD, test a flag the
// handler sets, sigsuspend with the old mask - must wake when the child exits, however the
// child's exit lands relative to the sigsuspend call. A signal delivered to a thread whose
// sigsuspend had been rewound (blocked, re-executed on wake) made the handler return to the
// syscall instruction: the call restarted, went back to sleep and never returned, and the
// shell never reaped a finished child (opencode --version, the sandbox's `wait $!` of a
// background job: roughly one run in three hung). Also checks the caller's signal mask is
// the one restored afterwards.
import { LinuxEngine } from '../linux.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'sigsus-'));
const src = join(dir, 't.c'), exe = join(dir, 't');
writeFileSync(src, `
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/wait.h>
static volatile sig_atomic_t got;
static void on_chld(int s) { (void)s; got = 1; }
int main(int argc, char** argv) {
  int n = argc > 1 ? atoi(argv[1]) : 30, bad = 0;
  struct sigaction sa; memset(&sa, 0, sizeof sa); sa.sa_handler = on_chld; sigaction(SIGCHLD, &sa, 0);
  sigset_t block, old; sigemptyset(&block); sigaddset(&block, SIGCHLD); sigaddset(&block, SIGUSR1);
  for (int i = 0; i < n; i++) {
    got = 0;
    sigprocmask(SIG_BLOCK, &block, &old);          // the caller's mask also blocks SIGUSR1
    pid_t p = fork();
    if (p == 0) { struct timespec ts = { 0, (long)((i % 7) * 3000000L) }; nanosleep(&ts, 0); _exit(i % 5); }
    while (!got) sigsuspend(&old);                 // returns -1/EINTR only after the handler ran
    int st = 0; if (waitpid(p, &st, 0) != p || !WIFEXITED(st) || WEXITSTATUS(st) != i % 5) bad++;
    sigset_t cur; sigprocmask(SIG_SETMASK, 0, &cur);
    if (!sigismember(&cur, SIGCHLD) || !sigismember(&cur, SIGUSR1)) bad++;   // sigsuspend restores the mask
    sigprocmask(SIG_SETMASK, &old, 0);
  }
  printf("done %d bad %d\\n", n, bad);
  return bad ? 1 : 0;
}
`);
try { execFileSync('cc', ['-O1', '-static', '-o', exe, src], { stdio: 'pipe' }); }
catch { console.log('sigsuspendtest SKIPPED: no static C toolchain (cc -static) on this host'); process.exit(0); }
const eng = new LinuxEngine(new Uint8Array(readFileSync(exe)), { argv: ['t', '60'], env: ['PATH=/bin'], files: {}, memMB: 256 });
const t0 = Date.now();
while (eng.exitCode === null && Date.now() - t0 < 120000) { eng.run(5e7); if (eng.blocked) eng.wake(); }
const out = eng.stdout.join('').trim();
if (eng.exitCode === 0 && out === 'done 60 bad 0') console.log('sigsuspend wait loop (60 children, handler + EINTR + mask restore) exact');
else { console.log('SIGSUSPENDTEST FAIL exit=' + eng.exitCode + ' out=' + JSON.stringify(out) + ' after ' + (Date.now() - t0) + ' ms'); process.exit(1); }

// Breadth: run unmodified system binaries end to end and check the engine
// produces byte-identical output to running them natively.
//
// The point is generality, not speed. Each case runs natively and on the
// engine with the AOT tier live, and stdout plus exit status must match
// exactly. A case that differs is a real bug in the engine, and printing the
// guest's own stdout alongside the fault is what turned "CPython faults
// during startup" into "CPython prints 42 and then crashes" - a failure
// address alone hides whether the program worked.
//
//   node tools/breadth.mjs            # every case
//   node tools/breadth.mjs sort grep  # only cases whose name matches
import { LinuxEngine } from '../engine/linux.mjs';
import { readFileSync, readdirSync, lstatSync, realpathSync, statSync, writeFileSync,
         existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const files = {}, mtimes = {};
const add = (g, h) => {
  try { files[g] = new Uint8Array(readFileSync(h)); mtimes[g] = Math.floor(statSync(h).mtimeMs / 1000); }
  catch {}
};
for (const d of ['/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu', '/lib64']) {
  let e; try { e = readdirSync(d); } catch { continue; }
  for (const f of e) { try { const r = realpathSync(join(d, f)); if (lstatSync(r).isFile()) add(join(d, f), r); } catch {} }
}
add('/etc/ld.so.cache', '/etc/ld.so.cache');
// tar resolves uname/gname through getpwuid/getgrgid: without these the
// engine's archive carries empty owner names (and a checksum to match)
// while native says root - a provisioning gap, not an engine one
add('/etc/passwd', '/etc/passwd');
add('/etc/group', '/etc/group');
// file(1) probes /etc/magic then /usr/share/misc/magic.mgc (a symlink into
// /usr/lib/file - provision the path the guest OPENS, not the target)
add('/etc/magic', '/etc/magic');
add('/etc/magic.mime', '/etc/magic.mime');
add('/etc/localtime', '/etc/localtime');
add('/usr/share/misc/magic.mgc', '/usr/share/misc/magic.mgc');
// ruby finds libruby through its RUNPATH (/opt/rbenv/...), a directory the
// standard lib-dir sweep never visits - provision the path its ld.so opens
add('/opt/rbenv/versions/3.3.6/lib/libruby.so.3.3', '/opt/rbenv/versions/3.3.6/lib/libruby.so.3.3');

// A shared input, written once so native and engine see identical bytes.
const IN = '/tmp/breadth_in.txt';
if (!existsSync(IN)) {
  const lines = [];
  for (let i = 0; i < 2000; i++) lines.push(`${(i * 7919) % 1000} line ${i} ${'abcdefghij'[i % 10].repeat(1 + i % 5)}`);
  writeFileSync(IN, lines.join('\n') + '\n');
}
add(IN, IN);

// The page-recycle fixture (tools/fixtures/recycle.asm): tier code at a
// fixed rwx page, munmap it, map different code at the same address - an
// engine that keeps address-keyed translations across munmap prints the
// stale answer. Built from the committed asm when nasm is present.
const RECYCLE = '/tmp/breadth_recycle';
if (!existsSync(RECYCLE)) {
  try { execFileSync('nasm', ['-f', 'bin', '-o', RECYCLE,
                              new URL('./fixtures/recycle.asm', import.meta.url).pathname]);
        execFileSync('chmod', ['+x', RECYCLE]); } catch {}
}

// The vfork+AOT fixture (tools/fixtures/vforkexec.c): tier a function, vfork,
// have the child execve a static binary, keep running in the parent. Before
// the interpUntil-depth fork guard, the tiered parent resumed corrupt after
// the child's execve unwound the nested interpreter and faulted. Built static
// from the committed source when gcc is present.
const VFORK = '/tmp/breadth_vforkexec';
if (!existsSync(VFORK)) {
  try { execFileSync('gcc', ['-O1', '-static', '-no-pie', '-o', VFORK,
                             new URL('./fixtures/vforkexec.c', import.meta.url).pathname]); } catch {}
}

// The concurrency fixture (tools/fixtures/thread.c): 8 pthreads each do 200k
// mutex-protected increments of a shared counter. Exercises clone(CLONE_THREAD),
// the futex-backed mutex and the park/wake/switchTo scheduler under contention;
// the total is 1600000 iff no update is lost and no thread is dropped. Built
// with -pthread from the committed source when gcc is present.
const THREAD = '/tmp/breadth_thread';
if (!existsSync(THREAD)) {
  try { execFileSync('gcc', ['-O1', '-pthread', '-o', THREAD,
                             new URL('./fixtures/thread.c', import.meta.url).pathname]); } catch {}
}

// The signal fixture (tools/fixtures/signal.c): sigaction+raise with
// SA_SIGINFO, a blocked signal held pending, setitimer+pause -> EINTR, an
// interrupted nanosleep, SIGCHLD reaped in the handler, sigsuspend and
// SA_RESETHAND. Every printed value is program-determined, not timing-
// determined, so it byte-compares to native.
const SIGNAL = '/tmp/breadth_signal';
if (!existsSync(SIGNAL)) {
  try { execFileSync('gcc', ['-O1', '-o', SIGNAL,
                             new URL('./fixtures/signal.c', import.meta.url).pathname]); } catch {}
}

// Shared file mappings + mremap (tools/fixtures/mshared.c) and SIGPIPE/EPIPE
// (tools/fixtures/epipe.c): see the fixture headers. Built when gcc is present.
const MSHARED = '/tmp/breadth_mshared';
if (!existsSync(MSHARED)) {
  try { execFileSync('gcc', ['-O1', '-o', MSHARED,
                             new URL('./fixtures/mshared.c', import.meta.url).pathname]); } catch {}
}
const FORKBLOCK = '/tmp/breadth_forkblock';
if (!existsSync(FORKBLOCK)) {
  try { execFileSync('gcc', ['-O1', '-o', FORKBLOCK,
                             new URL('./fixtures/forkblock.c', import.meta.url).pathname]); } catch {}
}
const PROCFS = '/tmp/breadth_procfs';
if (!existsSync(PROCFS)) {
  try { execFileSync('gcc', ['-O1', '-pthread', '-o', PROCFS,
                             new URL('./fixtures/procfs.c', import.meta.url).pathname]); } catch {}
}
const TIMERS = '/tmp/breadth_timers';
if (!existsSync(TIMERS)) {
  try { execFileSync('gcc', ['-O1', '-o', TIMERS,
                             new URL('./fixtures/timers.c', import.meta.url).pathname]); } catch {}
}
const PROCPID = '/tmp/breadth_procpid';
if (!existsSync(PROCPID)) {
  try { execFileSync('gcc', ['-O1', '-o', PROCPID,
                             new URL('./fixtures/procpid.c', import.meta.url).pathname]); } catch {}
}
const EPIPE = '/tmp/breadth_epipe';
if (!existsSync(EPIPE)) {
  try { execFileSync('gcc', ['-O1', '-o', EPIPE,
                             new URL('./fixtures/epipe.c', import.meta.url).pathname]); } catch {}
}

// patch inputs, written once like IN
const BP = '/tmp/bp';
if (!existsSync(BP + '/change.diff')) {
  mkdirSync(BP, { recursive: true });
  writeFileSync(BP + '/orig.txt', 'alpha\nbeta\ngamma\n');
  writeFileSync(BP + '/new.txt', 'alpha\nBETA\ngamma\ndelta\n');
  try { execFileSync('diff', ['-u', BP + '/orig.txt', BP + '/new.txt'], { cwd: BP }); } catch (e) { writeFileSync(BP + '/change.diff', e.stdout); }
}
add(BP + '/orig.txt', BP + '/orig.txt'); add(BP + '/change.diff', BP + '/change.diff');

// A C source for the compiler cases, written once like IN.
const HELLO_C = '/tmp/breadth_hello.c';
if (!existsSync(HELLO_C))
  writeFileSync(HELLO_C, 'int main(){__builtin_printf("hi from compiled C\\n");return 0;}\n');
add(HELLO_C, HELLO_C);
const HELLO_CPP = '/tmp/breadth_hello.cpp';
if (!existsSync(HELLO_CPP))
  writeFileSync(HELLO_CPP, '#include <cstdio>\nint main(){std::printf("hi from C++\\n");return 0;}\n');
add(HELLO_CPP, HELLO_CPP);

// wat2wasm for the AOT tier; cached by text hash so repeat cases are cheap
const CACHE = new URL('../bench/kernels/watcache/', import.meta.url).pathname;
mkdirSync(CACHE, { recursive: true });
let an = 0;
const assembleWat = (wat) => {
  const h = createHash('sha1').update(wat).digest('hex'), cp = CACHE + h + '.wasm';
  if (existsSync(cp)) return new Uint8Array(readFileSync(cp));
  const w = `/tmp/bw_${process.pid}_${an++}`;
  writeFileSync(w + '.wat', wat);
  execFileSync('wat2wasm', ['--enable-tail-call', w + '.wat', '-o', w + '.wasm']);
  const b = new Uint8Array(readFileSync(w + '.wasm'));
  try { unlinkSync(w + '.wat'); unlinkSync(w + '.wasm'); } catch {}
  try { writeFileSync(cp, b); } catch {}
  return b;
};

// tree: provision a whole directory (an interpreter is not one file - without
// its stdlib CPython never reaches main, and the case would measure its own
// startup failure). Walked once per distinct tree.
const walked = new Set();
const walk = (d) => { if (walked.has(d)) return; walked.add(d);
  let e; try { e = readdirSync(d); mtimes[d] = Math.floor(statSync(d).mtimeMs / 1000); } catch { return; }   // dirs carry mtimes too (ls -l)
  for (const f of e) { const hp = join(d, f);
    let st; try { st = lstatSync(hp); } catch { continue; }
    if (st.isDirectory()) walk(hp); else { try { add(hp, realpathSync(hp)); } catch {} } } };

const CASES = [
  ['wc',      '/usr/bin/wc',      ['-l', '-w', '-c', IN]],
  ['head',    '/usr/bin/head',    ['-n', '5', IN]],
  ['sort',    '/bin/sort',        [IN]],
  ['sort-n',  '/bin/sort',        ['-n', IN]],
  ['uniq',    '/usr/bin/uniq',    ['-c', IN]],
  ['grep',    '/bin/grep',        ['-c', 'line 1', IN]],
  ['grep-re', '/bin/grep',        ['-E', '^[0-9]{3} line [0-9]+ a+$', IN]],
  ['sed',     '/bin/sed',         ['s/line/LINE/g;10q', IN]],
  ['tr',      '/usr/bin/tr',      ['a-z', 'A-Z']],
  ['cut',     '/usr/bin/cut',     ['-d', ' ', '-f', '2,3', IN]],
  ['base64',  '/usr/bin/base64',  [IN]],
  ['md5sum',  '/usr/bin/md5sum',  [IN]],
  ['sha256',  '/usr/bin/sha256sum', [IN]],
  ['od',      '/usr/bin/od',      ['-A', 'x', '-t', 'x1', '-N', '256', IN]],
  ['seq',     '/usr/bin/seq',     ['1', '2', '999']],
  ['factor',  '/usr/bin/factor',  ['600851475143', '1234567891', '999999999989']],
  ['expr',    '/usr/bin/expr',    ['31337', '*', '1337']],
  ['printf',  '/usr/bin/printf',  ['%s=%d %.4f\n', 'x', '42', '3.14159']],
  ['nl',      '/usr/bin/nl',      [IN]],
  ['fold',    '/usr/bin/fold',    ['-w', '13', IN]],
  ['paste',   '/usr/bin/paste',   ['-d', ':', IN, IN]],
  ['bc',      '/usr/bin/bc',      ['-q']],
  // xz -9 reserves a 512MB+ dictionary, more than the default guest. Give it
  // room so this case tests compression; the out-of-memory path is covered by
  // the brk fix, where it now exits 1 like native instead of faulting.
  ['xz',      '/usr/bin/xz',      ['-9', '-c', IN], { memMB: 1536 }],
  ['xz-1',    '/usr/bin/xz',      ['-1', '-c', IN]],
  ['gzip',    '/bin/gzip',        ['-9', '-c', IN]],
  ['diff',    '/usr/bin/diff',    ['-u', IN, IN]],
  ['sh',      '/bin/sh',          ['-c', 'echo start; for i in 1 2 3; do echo line $i; done; echo done']],
  ['perl',    '/usr/bin/perl',    ['-e', 'my $s=0; $s+=$_ for 1..100; print "sum=$s\n"; print join(",", map { $_*$_ } 1..8), "\n"']],
  ['openssl', '/usr/bin/openssl', ['dgst', '-sha256', IN]],
  ['openssl-b64', '/usr/bin/openssl', ['enc', '-base64', '-in', IN]],
  // The two-tier CPython case that took two silicon-semantics bugs to make
  // pass (movhlps moving the wrong half, bsr clobbering a preserved
  // destination). It stays in the sweep so neither can regress silently.
  ['python3', '/usr/bin/python3', ['-S', '-c', 'print(6*7); print(sorted("breadth")); print(sum(range(100)))'],
              { tree: '/usr/lib/python3.11', memMB: 1024 }],
  ['jq',      '/usr/bin/jq',      ['-c', '{n: (.a + .b), l: [.a, .b] | map(. * 2)}']],
  ['zstd',    '/usr/bin/zstd',    ['-19', '-c', IN]],
  ['bzip2',   '/bin/bzip2',       ['-9', '-c', IN]],
  ['tar',     '/bin/tar',         ['-cf', '-', IN]],
  ['dash',    '/bin/dash',        ['-c', 'x=1; while [ $x -le 20 ]; do echo "n$x"; x=$((x+1)); done']],
  ['rev',     '/usr/bin/rev',     [IN]],
  ['tac',     '/usr/bin/tac',     [IN]],
  ['tail',    '/usr/bin/tail',    ['-n', '5', IN]],
  ['b2sum',   '/usr/bin/b2sum',   [IN]],
  ['sha1',    '/usr/bin/sha1sum', [IN]],
  ['sha224',  '/usr/bin/sha224sum', [IN]],
  ['sha384',  '/usr/bin/sha384sum', [IN]],
  ['numfmt',  '/usr/bin/numfmt',  ['--to=iec', '1048576', '2000000', '999']],
  ['unexpand','/usr/bin/unexpand',['-t', '4', IN]],
  ['basename','/usr/bin/basename',['/usr/lib/gcc/x86_64/13/cc1', '.c']],
  ['dirname', '/usr/bin/dirname', ['/a/b/c/d']],
  ['expand',  '/usr/bin/expand',  ['-t', '3', IN]],
  ['fmt',     '/usr/bin/fmt',     ['-w', '40', IN]],
  ['awk',     '/usr/bin/mawk',    ['{ s += $1; n++ } END { print s, n, NR }', IN]],
  ['git-hash','/usr/bin/git',     ['hash-object', '--stdin']],
  ['file',    '/usr/bin/file',    [IN]],
  ['comm',    '/usr/bin/comm',    [IN, IN]],
  ['join',    '/usr/bin/join',    [IN, IN]],
  ['tsort',   '/usr/bin/tsort',   []],
  ['strings', '/usr/bin/strings', [IN]],
  ['cksum',   '/usr/bin/cksum',   [IN]],
  ['sha512',  '/usr/bin/sha512sum', [IN]],
  ['sum',     '/usr/bin/sum',     [IN]],
  ['pr',      '/usr/bin/pr',      ['-t', '-2', '-w', '80', IN]],
  ['ptx',     '/usr/bin/ptx',     ['-w', '60', IN]],
  // --random-source pinned to the input file makes the permutation a pure
  // function of provisioned bytes - byte-identical native vs engine
  ['shuf',    '/usr/bin/shuf',    ['--random-source=' + IN, IN]],
  // statically linked: the no-ld.so lane end to end (entry straight at
  // _start, static TLS, no PT_INTERP), which nothing else in the sweep hits
  ['busybox-sh',  '/usr/bin/busybox', ['sh', '-c', 'i=0; while [ $i -lt 10 ]; do echo bb$i; i=$((i+1)); done']],
  // the abort lane: a self-delivered fatal signal must terminate with the
  // default action (128+sig), the path php's fortify abort takes
  ['abort',   '/bin/dash',        ['-c', 'echo before; kill -ABRT $$; echo unreachable']],
  // the subprocess lane: fork/execve/pipes/wait4 driven by a real shell -
  // gzip -n so neither name nor mtime lands in the stream
  ['pipe-gz', '/bin/dash',        ['-c', `/bin/gzip -n -1 -c ${IN} | /usr/bin/md5sum`],
              { bins: ['/bin/gzip', '/usr/bin/md5sum'] }],
  ['pipe-3',  '/bin/dash',        ['-c', '/usr/bin/seq 1 1000 | /bin/sort -rn | /usr/bin/head -5'],
              { bins: ['/usr/bin/seq', '/bin/sort', '/usr/bin/head'] }],
  ['dd',      '/usr/bin/dd',      [`if=${IN}`, 'bs=1024', 'count=20', 'status=none']],
  ['cmp',     '/usr/bin/cmp',     [IN, IN]],
  ['date',    '/usr/bin/date',    ['-u', '-d', '@1600000000', '+%Y-%m-%d %H:%M:%S']],
  ['busybox-md5', '/usr/bin/busybox', ['md5sum', IN]],
  // ruby's VM reserves ~500MB of address space at boot and exits 1 (silently)
  // when mmap says ENOMEM - it needs headroom above breadth's 512MB default
  ['ruby',    '/opt/ruby-3.3.6/bin/ruby', ['--disable-gems', '-e', 'puts 6*7; puts (1..100).sum; puts "breadth".chars.sort.join'],
              { memMB: 1024 }],
  // php scans the system tzdata at startup; with the directory missing it
  // takes a fallback that dies in a fortify abort ("buffer overflow
  // detected") - provision the tree so engine and native walk the same world
  ['php',     '/usr/bin/php8.4', ['-n', '-r', 'echo 6*7, "\n", array_sum(range(1,100)), "\n", strrev("breadth"), "\n";'],
              { tree: '/usr/share/zoneinfo' }],
  // Node 22 (V8, libuv, epoll, worker threads) end to end - jitless keeps
  // V8 off its runtime-codegen path, which is a separate frontier. Getting
  // here took the epoll family, EBADF from fcntl on dead fds, a finite
  // RLIMIT_NOFILE, and pop r/m64 in the decoder.
  ['node',    '/opt/node22/bin/node', ['--jitless', '-e', 'console.log(6*7)'], { memMB: 2048 }],
  // full JIT: V8 writes Sparkplug and irregexp machine code into rwx pages
  // at runtime and the engine executes (and tiers) it - the JIT-in-JIT lane.
  // The 3e6-iteration TurboFan stress lives in scratch tooling; this sized-
  // down loop keeps the sweep's wall clock sane while still forcing codegen.
  ['node-jit','/opt/node22/bin/node', ['-e', 'let s=0; for (let i=0;i<3e5;i++) s+=i%7; console.log(s, /a(b+)c/.exec("xabbbcy")[1])'], { memMB: 2048 }],
  // a real repo, read paths: object walk + index + worktree stat. The
  // fixture at /tmp/breadth_repo is committed with pinned dates so the
  // hash is stable; safe.directory silences ownership checks that would
  // otherwise depend on who stat() says owns the files.
  ['git-log',   '/usr/bin/git', ['-C', '/tmp/breadth_repo', '-c', 'safe.directory=*', 'log', '--format=%H %s'],
                { tree: '/tmp/breadth_repo' }],
  ['git-status','/usr/bin/git', ['-C', '/tmp/breadth_repo', '-c', 'safe.directory=*', 'status', '--porcelain'],
                { tree: '/tmp/breadth_repo' }],
  // the write path: init creates the .git tree from nothing
  ['git-init',  '/usr/bin/git', ['init', '-q', '/tmp/fresh_repo']],
  // self-modifying-code lane: must print B (the recycled page's NEW code),
  // never A (a stale translation of the munmapped bytes)
  ['recycle',   '/tmp/breadth_recycle', []],
  // the vfork-from-a-tiered-frame lane: prints "survived" only if the parent
  // is not corrupted when its vfork child execs. busybox is the child's exec.
  ['vforkexec', '/tmp/breadth_vforkexec', [],
                { bins: ['/usr/bin/busybox'] }],
  // the concurrency lane: 8 pthreads, 200k mutex-protected increments each.
  // Prints 1600000 iff clone/futex/scheduler lose no update under contention.
  ['thread',    '/tmp/breadth_thread', []],
  // the signal lane: real handler delivery (rt_sigframe, rt_sigreturn),
  // EINTR/restart semantics, timers, SIGCHLD, masks. See fixtures/signal.c.
  ['signal',    '/tmp/breadth_signal', []],
  // shared file mappings: stores through MAP_SHARED reach the file at msync,
  // munmap and exit (the file is compared after the process is gone); a
  // store past EOF does not grow it; mremap moves and grows a region.
  ['mshared',   '/tmp/breadth_mshared', [], { outFile: '/tmp/breadth_mshared.dat' }],
  // SIGPIPE/EPIPE: writes to a reader-less pipe under SIG_IGN, a handler,
  // and the default action (a forked child killed, WIFSIGNALED reported)
  ['epipe',     '/tmp/breadth_epipe', []],
  // fork materialisation: a child that blocks before exec/exit (fills a pipe
  // past 64KB; reads before the parent writes) becomes a real child engine
  // instead of freezing its parent; memory is private both ways.
  ['forkblock', '/tmp/breadth_forkblock', []],
  // synthetic /proc and /dev: cmdline/environ/maps/status/fd/N, /dev/zero,
  // /dev/urandom, cpuinfo/meminfo/sys; glibc's pthread_getattr_np walks maps
  ['procfs',    '/tmp/breadth_procfs', ['alpha']],
  // timers and signal descriptors: timerfd (one-shot, interval via poll),
  // signalfd, sigtimedwait (+EAGAIN), POSIX timers with SI_TIMER siginfo,
  // ITIMER_VIRTUAL while spinning with occasional syscalls
  ['timers',    '/tmp/breadth_timers', []],
  // distinct pids across fork, mmap coherence in both directions, /proc listings
  ['procpid',   '/tmp/breadth_procpid', []],
  // ---- programs that lean on the new kernel model from the outside ----
  // coreutils timeout: SIGALRM, then SIGTERM to the child; exit 124
  ['timeout',   '/usr/bin/timeout', ['0.2', 'sleep', '5'], { bins: ['/usr/bin/sleep'] }],
  // bash: trap + kill -USR1 $$ (distinct pid, handler delivery), functions, arrays, arithmetic
  ['bash-trap', '/bin/bash', ['-c', 'trap "echo got USR1" USR1; kill -USR1 $$; echo after; f(){ echo "f:$1"; }; f x; a=(1 2 3); echo ${#a[@]} $((7*6))']],
  // python multiprocessing: fork children that never exec, blocking on pipes
  ['python-mp', '/usr/bin/python3', ['-S', new URL('./fixtures/mp.py', import.meta.url).pathname],
                { tree: '/usr/lib/python3.11', bins: [new URL('./fixtures/mp.py', import.meta.url).pathname], memMB: 1024 }],
  // python: ITIMER_REAL interrupts time.sleep, PEP 475 retries it
  ['python-sig','/usr/bin/python3', ['-S', new URL('./fixtures/sig.py', import.meta.url).pathname],
                { tree: '/usr/lib/python3.11', bins: [new URL('./fixtures/sig.py', import.meta.url).pathname], memMB: 1024 }],
  // a FIFO: mkfifo, a background writer, a reader that blocks on open
  ['fifo',      '/bin/bash', ['-c', 'rm -f /tmp/breadth_fifo; mkfifo /tmp/breadth_fifo && (echo hello > /tmp/breadth_fifo &); cat /tmp/breadth_fifo; rm -f /tmp/breadth_fifo'],
                { bins: ['/usr/bin/mkfifo', '/usr/bin/cat', '/usr/bin/rm'] }],
  // xargs / find -exec: many short-lived fork+exec children
  ['xargs',     '/bin/bash', ['-c', 'printf "a\\nb\\nc\\n" | xargs -n1 echo x'], { bins: ['/usr/bin/xargs', '/usr/bin/echo'] }],
  // (readdir order is filesystem-dependent natively, so the output is sorted)
  ['find-exec', '/bin/bash', ['-c', 'find /tmp/breadth_repo -maxdepth 1 -name "*.txt" -exec basename {} \\; | sort'],
                { tree: '/tmp/breadth_repo', bins: ['/usr/bin/find', '/usr/bin/basename', '/usr/bin/sort'] }],
  // patch: applies a unified diff to stdout
  ['patch',     '/usr/bin/patch', ['-s', '-o', '-', '/tmp/bp/orig.txt', '/tmp/bp/change.diff']],
  // flock: advisory lock on a file, then exec sh -c
  ['flock',     '/usr/bin/flock', ['/tmp/bp/lock', '-c', 'echo locked'], { bins: ['/bin/sh'] }],
  // tee: a pipeline that writes a file and passes bytes through
  ['tee',       '/bin/bash', ['-c', 'printf "x\\ny\\n" | tee /tmp/bp/tee.out | wc -l; cat /tmp/bp/tee.out'],
                { bins: ['/usr/bin/tee', '/usr/bin/wc', '/usr/bin/cat'] }],
  // sort with a tiny buffer: external merge through temp files
  ['sort-S',    '/bin/sort',       ['-S', '1K', IN]],
  // python subprocess: posix_spawn + pipe capture + wait
  ['python-sub','/usr/bin/python3', ['-S', new URL('./fixtures/sub.py', import.meta.url).pathname],
                { tree: '/usr/lib/python3.11', bins: [new URL('./fixtures/sub.py', import.meta.url).pathname, '/usr/bin/echo', '/bin/sh'], memMB: 1024 }],
  // perl fork + waitpid + exit status
  ['perl-fork', '/usr/bin/perl', ['-e', 'if(my $p=fork){waitpid($p,0); print "parent ".($?>>8)."\\n"} else {print "child\\n"; exit 3}']],
  // bash process substitution: /proc/self/fd/N handed to diff and cat
  ['bash-psub', '/bin/bash', ['-c', 'diff <(printf "a\\nb\\n") <(printf "a\\nc\\n"); echo "rc=$?"; cat <(echo sub)'],
                { bins: ['/usr/bin/diff', '/usr/bin/cat'] }],
  // env -i: a scrubbed environment, then exec
  ['env-i',     '/usr/bin/env',   ['-i', 'FOO=1', '/usr/bin/env']],
  // GNU make: dependency graph, recipes through /bin/sh, up-to-date check
  ['make',      '/bin/bash', ['-c', 'cd /tmp/bm && rm -f a.txt b.txt out.txt && make -s && cat out.txt && make -q; echo rc=$?'],
                { tree: '/tmp/bm', bins: ['/usr/bin/make', '/bin/sh', '/usr/bin/cat', '/usr/bin/rm', '/usr/bin/echo'] }],
  // an awk program file: functions, arrays, printf
  ['awk-prog',  '/usr/bin/awk', ['-f', new URL('./fixtures/prog.awk', import.meta.url).pathname, IN],
                { bins: [new URL('./fixtures/prog.awk', import.meta.url).pathname] }],
  // tar extract: directories, a symlink (symlinkat), then find/readlink over the result
  ['tar-x',     '/bin/bash', ['-c', 'rm -rf /tmp/bt/out; mkdir -p /tmp/bt/out && tar -xf /tmp/bt/arc.tar -C /tmp/bt/out && cd /tmp/bt/out && find src | sort && cat src/link && readlink src/link'],
                { bins: ['/tmp/bt/arc.tar', '/usr/bin/tar', '/usr/bin/find', '/usr/bin/sort', '/usr/bin/cat', '/usr/bin/readlink', '/usr/bin/mkdir', '/usr/bin/rm'] }],
  // python threads + queue + lock: futex-backed producers/consumers
  ['python-thr','/usr/bin/python3', ['-S', new URL('./fixtures/thr.py', import.meta.url).pathname],
                { tree: '/usr/lib/python3.11', bins: [new URL('./fixtures/thr.py', import.meta.url).pathname], memMB: 1024 }],
  // ruby fork + Process.wait + exit status — OPEN: the forked child never
  // finishes under the engine (docs: "Ruby fork"); parked until the child
  // engine can be traced
  // ['ruby-fork', '/opt/ruby-3.3.6/bin/ruby', ['--disable-gems', '-e', 'p = fork { puts "child"; exit 4 }; Process.wait(p); puts "parent #{$?.exitstatus}"'],
  //               { memMB: 1024 }],
  // git: init, add, commit, list the tree (blob ids are content-addressed)
  ['git-commit','/bin/bash', ['-c', 'rm -rf /tmp/gc; git init -q /tmp/gc && cd /tmp/gc && echo a > f && git add f && git -c user.name=x -c user.email=y commit -q -m m && git ls-tree HEAD && git log --format=%s'],
                { bins: ['/usr/bin/git', '/usr/bin/rm'] }],
  // threaded xz: worker threads with big shared buffers
  ['xz-T2',     '/usr/bin/xz',     ['-T2', '-c', IN], { memMB: 1536 }],
  // ls -l: getdents + stat (nlink, 4K block counts, mtimes, owner names) on a
  // real tree (no -a: `..` would be the host's own /tmp)
  ['ls-l',      '/usr/bin/ls',     ['-l', '/tmp/breadth_repo'], { tree: '/tmp/breadth_repo' }],
  // the same through busybox: a NOEXEC applet's 170KB command substitution
  ['bb-subst',  '/usr/bin/busybox', ['sh', '-c', 'x=$(seq 1 30000); echo ${#x}'],
                { bins: ['/usr/bin/busybox'] }],
  // the classic: head exits, yes must die of SIGPIPE instead of filling a
  // dead pipe forever; bash reports the killed stage's status (141)
  ['sigpipe-sh','/bin/bash', ['-c', 'yes | head -1; echo "${PIPESTATUS[0]} ${PIPESTATUS[1]}"'],
                { bins: ['/usr/bin/yes', '/usr/bin/head'] }],
  // binutils: libbfd + libopcodes, a whole codebase the coreutils cases never
  // touch. The input ELF (/bin/true) is provisioned as a read-only file; every
  // tool's output is a pure function of its bytes, so it byte-compares.
  ['readelf',   '/usr/bin/readelf', ['-a', '/bin/true'], { bins: ['/bin/true'] }],
  ['objdump',   '/usr/bin/objdump', ['-d', '/bin/true'], { bins: ['/bin/true'] }],  // libopcodes disassembler
  ['nm-d',      '/usr/bin/nm',      ['-D', '/bin/true'], { bins: ['/bin/true'] }],
  ['size',      '/usr/bin/size',    ['/bin/true'],       { bins: ['/bin/true'] }],
  // the compiler lane: gcc's driver vforks cc1 (the case that drove the
  // interpUntil-depth fork fix); assembly comes back on stdout. Preprocessor,
  // front end and back end of a 30MB binary, byte-compared to native.
  ['gcc-S', '/usr/bin/gcc', ['-S', '-o', '-', '-O1', HELLO_C],
            { bins: ['/usr/libexec/gcc/x86_64-linux-gnu/13/cc1'],
              tree: ['/usr/include', '/usr/lib/gcc/x86_64-linux-gnu/13/include'],
              memMB: 1024 }],
  // the full compile+assemble chain: driver -> cc1 -> as, producing an ELF
  // object byte-compared to native (via outFile, the engine's virtual FS).
  ['gcc-c', '/usr/bin/gcc', ['-c', '-O1', '-o', '/tmp/breadth_hello.o', HELLO_C],
            { bins: ['/usr/libexec/gcc/x86_64-linux-gnu/13/cc1', '/usr/bin/as',
                     '/usr/bin/x86_64-linux-gnu-as'],
              tree: ['/usr/include', '/usr/lib/gcc/x86_64-linux-gnu/13/include'],
              outFile: '/tmp/breadth_hello.o', memMB: 1024 }],
  // the whole toolchain end to end: driver -> cc1 -> as -> collect2 -> ld,
  // producing a dynamic PIE byte-compared to native gcc's (build-id included,
  // since the output is bit-reproducible). This exercised the read-past-EOF
  // position bug that left ld's _start zero-filled — glibc's stdio reads a
  // block ahead of a still-sparse output file, and a negative short-read
  // count used to rewind the file position under the next section write.
  ['gcc-link', '/usr/bin/gcc', ['-O1', '-o', '/tmp/breadth_hello_aout', HELLO_C],
            { bins: ['/usr/libexec/gcc/x86_64-linux-gnu/13/cc1', '/usr/bin/as',
                     '/usr/bin/x86_64-linux-gnu-as',
                     '/usr/libexec/gcc/x86_64-linux-gnu/13/collect2',
                     '/usr/bin/ld', '/usr/bin/x86_64-linux-gnu-ld',
                     '/usr/bin/x86_64-linux-gnu-ld.bfd'],
              tree: ['/usr/include', '/usr/lib/gcc/x86_64-linux-gnu/13/include',
                     '/usr/lib/gcc/x86_64-linux-gnu/13'],
              outFile: '/tmp/breadth_hello_aout', memMB: 1024 }],
  // the C++ frontend end to end: g++ -> cc1plus (a much larger front end than
  // cc1) -> as -> collect2 -> ld, producing a PIE byte-compared to native.
  // Exercises the same toolchain generality on a heavier translation load.
  ['gpp-link', '/usr/bin/g++', ['-O1', '-o', '/tmp/breadth_hello_cpp_aout', HELLO_CPP],
            { bins: ['/usr/libexec/gcc/x86_64-linux-gnu/13/cc1plus', '/usr/bin/as',
                     '/usr/bin/x86_64-linux-gnu-as',
                     '/usr/libexec/gcc/x86_64-linux-gnu/13/collect2',
                     '/usr/bin/ld', '/usr/bin/x86_64-linux-gnu-ld',
                     '/usr/bin/x86_64-linux-gnu-ld.bfd'],
              tree: ['/usr/include', '/usr/lib/gcc/x86_64-linux-gnu/13/include',
                     '/usr/lib/gcc/x86_64-linux-gnu/13'],
              outFile: '/tmp/breadth_hello_cpp_aout', memMB: 2048 }],
];
const STDIN = { tr: readFileSync(IN), bc: Buffer.from('scale=20\n7/3\n2^64\nsqrt(2)\nquit\n'),
                jq: Buffer.from('{"a": 3, "b": 4}\n{"a": 10, "b": -2}\n'),
                'git-hash': readFileSync(IN),
                tsort: Buffer.from('a b\nb c\nc d\na d\n') };

const only = process.argv.slice(2);
const pick = (n) => !only.length || only.some(o => n.includes(o));

// a native process killed by a signal has status null in node; normalize to
// the shell's 128+sig so it compares against the engine's default-action code
const SIGN = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6,
               SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGSEGV: 11, SIGPIPE: 13, SIGTERM: 15 };
const native = (bin, args, stdin) => {
  try { const out = execFileSync(bin, args, { input: stdin, maxBuffer: 1 << 28 });
        return { out, code: 0 }; }
  catch (e) { return { out: e.stdout ?? Buffer.alloc(0),
                       code: e.status ?? (e.signal ? 128 + (SIGN[e.signal] || 0) : -1) }; }
};

const engine = (bin, args, stdin, opts = {}) => {
  add(bin, bin);
  const eng = new LinuxEngine(new Uint8Array(readFileSync(bin)),
    { argv: [bin, ...args], env: ['PATH=/usr/bin:/bin', 'HOME=/root', 'LANG=C'],
      files, mtimes, memMB: opts.memMB || 512, assembleWat, stdin });

  if (process.env.BREADTH_STRACE) eng.strace = [];
  const t0 = process.hrtime.bigint();
  let err = null;
  try {
    let guard = 0;
    // A blocked engine with a future deadline is WAITING (nanosleep, an
    // itimer, a poll timeout): sleep until then like a real host would,
    // instead of spinning through the guard in a few ms of wall time.
    const nap = new Int32Array(new SharedArrayBuffer(4));
    while (eng.exitCode === null) {
      eng.run(5e7);
      if (eng.blocked) {
        const dl = eng.blocked.deadline;
        if (dl != null && isFinite(dl)) { const ms = dl - eng.nowMs(); if (ms > 0) { Atomics.wait(nap, 0, 0, Math.min(ms, 1000)); guard--; } }
        eng.wake();
      }
      if (++guard > 4000) { err = 'no exit after 200e9 steps'; break; }
    }
  } catch (e) { err = e.message; }
  // stdoutBytes, not stdout: the string view mangles binary output, and
  // comparing it reported gzip as differing from byte 1 when the bytes were
  // fine. A generality harness that corrupts its own evidence is worse than
  // none.
  // A case that produces a FILE (gcc -c writes an object) compares the file's
  // bytes from the engine's virtual FS instead of stdout.
  const raw = opts.outFile
    ? (eng.files[opts.outFile] ? Buffer.from(eng.files[opts.outFile]) : Buffer.alloc(0))
    : eng.stdoutBytes && eng.stdoutBytes.length
      ? Buffer.concat(eng.stdoutBytes.map(b => Buffer.from(b)))
      : Buffer.from(eng.stdout.join(''), 'binary');
  return { out: raw, code: eng.exitCode, stderr: (eng.stderr || []).join(''),
           unknown: [...(eng.unknown || [])], strace: eng.strace,
           ioctls: (() => { const m = new Map(); const walk = (e) => { for (const [k, n] of e.unknownIoctl ?? []) m.set(k, (m.get(k) || 0) + n);
                            for (const c of e.children ?? []) if (c.eng) walk(c.eng); };
                            walk(eng); return [...m].map(([k, n]) => `${k}x${n}`); })(),
           ms: Number(process.hrtime.bigint() - t0) / 1e6,
           units: eng.aotFns.size, insns: eng.stats.interpreted, err };
};

let pass = 0, fail = 0;
const failures = [];
for (const [name, bin, args, opts] of CASES) {
  if (!pick(name)) continue;
  if (!existsSync(bin)) { console.log(`  SKIP ${name.padEnd(9)} (${bin} not present)`); continue; }
  const stdin = STDIN[name] || null;
  if (opts && opts.tree) for (const t of [].concat(opts.tree)) walk(t);
  if (opts && opts.bins) for (const b of opts.bins) add(b, b);   // child-exec binaries
  const nat = native(bin, args, stdin);
  // outFile case: native wrote the file to the real FS; read it as the oracle
  if (opts && opts.outFile) { try { nat.out = readFileSync(opts.outFile); } catch { nat.out = Buffer.alloc(0); } }
  const eng = engine(bin, args, stdin, opts);
  // compare the bytes, not a summary: a truncated stdout that happens to
  // share a prefix is exactly the failure a length check alone would miss
  const same = eng.code === nat.code && Buffer.compare(eng.out, nat.out) === 0;
  if (same) { pass++;
    console.log(`  ok   ${name.padEnd(9)} ${String(nat.out.length).padStart(8)}B out, ` +
                `${eng.units} fns, ${(eng.ms).toFixed(0)}ms`);
    if (eng.unknown.length) console.log(`         ENOSYS syscalls: ${eng.unknown.join(' ')}`);
    if (eng.ioctls.length) console.log(`         ENOTTY ioctls: ${eng.ioctls.join(' ')}`); }
  else { fail++;
    const why = eng.err ? `threw: ${eng.err}`
      : eng.code !== nat.code ? `exit ${eng.code} vs native ${nat.code}`
      : `stdout ${eng.out.length}B vs native ${nat.out.length}B`;
    failures.push([name, why]);
    console.log(`  FAIL ${name.padEnd(9)} ${why}`);
    // the guest's own words first: "error while loading shared libraries:
    // libfoo" is a provisioning gap, a fault address is an engine bug
    if (eng.stderr) console.log(`         guest stderr: ${JSON.stringify(eng.stderr.slice(0, 300))}`);
    if (eng.unknown.length) console.log(`         ENOSYS syscalls: ${eng.unknown.join(' ')}`);
    if (eng.ioctls.length) console.log(`         ENOTTY ioctls: ${eng.ioctls.join(' ')}`);
    if (eng.strace) console.log(`         last syscalls:\n           ${eng.strace.slice(-60).join('\n           ')}`);
    if (!eng.err && eng.out.length && nat.out.length) {
      let i = 0; while (i < eng.out.length && i < nat.out.length && eng.out[i] === nat.out[i]) i++;
      console.log(`         first difference at byte ${i}`);
      console.log(`         engine: ${JSON.stringify(eng.out.subarray(Math.max(0,i-20), i+40).toString('latin1'))}`);
      console.log(`         native: ${JSON.stringify(nat.out.subarray(Math.max(0,i-20), i+40).toString('latin1'))}`);
    }
  }
}
console.log(`\n${pass}/${pass + fail} unmodified binaries byte-identical to native`);
if (failures.length) { console.log('failures:'); for (const [n, w] of failures) console.log(`  ${n}: ${w}`); }
process.exit(fail ? 1 : 0);

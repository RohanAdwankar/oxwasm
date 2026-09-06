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
import { ensureHeapFlags } from './v8flags.mjs';
ensureHeapFlags();
import { LinuxEngine } from '../engine/linux.mjs';
import { setFlagsFromString } from 'node:v8';
if (process.env.WASM_LAZY !== '0') setFlagsFromString('--wasm-lazy-compilation');   // V8 compiles each wasm function at its first call: most translated functions of a compiler run are never entered (clang -S 45 s -> 39 s), m4 steady state neutral on a quiet machine; WASM_LAZY=0 restores eager
import { makeAssembler } from './assemble.mjs';
import { readFileSync, readdirSync, lstatSync, realpathSync, statSync, writeFileSync, existsSync, mkdirSync, unlinkSync, copyFileSync, opendirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const files = {}, mtimes = {};
const byReal = new Map();   // /lib/x86_64-linux-gnu and /usr/lib/x86_64-linux-gnu are one directory: one copy of the bytes (the doubled copy was half of a 4 GB floor)
const add = (g, h) => {
  try { let b = byReal.get(h); if (!b) { b = new Uint8Array(readFileSync(h)); byReal.set(h, b); } files[g] = b; mtimes[g] = Math.floor(statSync(h).mtimeMs / 1000); }
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
// an archive fixture: a small tree zipped natively once; zip re-archives it
// (DOS timestamps from the provisioned mtimes), unzip lists it
const ZIPDIR = '/tmp/breadth_zipdir', ZIPF = '/tmp/breadth_z.zip';
if (!existsSync(ZIPF)) {
  try { mkdirSync(ZIPDIR + '/sub', { recursive: true }); writeFileSync(ZIPDIR + '/a.txt', 'alpha\n');
        writeFileSync(ZIPDIR + '/sub/big.txt', 'x'.repeat(20000)); copyFileSync(new URL('./fixtures/dlfail.c', import.meta.url).pathname, ZIPDIR + '/sub/dlfail.c');
        execFileSync('zip', ['-q', '-r', '-X', ZIPF, 'breadth_zipdir'], { cwd: '/tmp' }); } catch {}
}
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
const CONDWAIT = '/tmp/breadth_condwait';
if (!existsSync(CONDWAIT)) {   // pthread_cond_timedwait with no signaller, three condvar clocks: a timed futex wait must time out
  try { execFileSync('gcc', ['-O1', '-pthread', '-o', CONDWAIT, new URL('./fixtures/condwait.c', import.meta.url).pathname]); } catch {}
}
const JHELLO = '/tmp/breadth_jhello';
if (!existsSync(JHELLO + '/Hello.class')) {   // Java: HotSpot's runtime-generated template interpreter running bytecode
  try {
    execFileSync('mkdir', ['-p', JHELLO]);
    writeFileSync(JHELLO + '/Hello.java', [
      'public class Hello {',
      '  public static void main(String[] a) {',
      '    long s = 0; for (int i = 0; i < 200000; i++) s += (i * 7L) % 13;',
      '    StringBuilder b = new StringBuilder(); for (int i = 0; i < 5; i++) b.append(i).append(\',\');',
      '    System.out.println("hello from java " + s + " " + b + " " + Integer.toHexString(0xCAFE) + " " + Math.sqrt(2.0));',
      '  }',
      '}', ''].join('\n'));
    execFileSync('/usr/lib/jvm/java-21-openjdk-amd64/bin/javac', ['-d', JHELLO, JHELLO + '/Hello.java'], { env: { PATH: process.env.PATH } });
  } catch (e) { console.log('  (javac unavailable: ' + String(e.stderr || e.message).split('\n')[0] + ')'); }
}
const GOSTR = '/tmp/breadth_gostrings';
if (!existsSync(GOSTR)) {
  // Go: the runtime's page allocator (huge PROT_NONE reservations, rcr),
  // three threads at start, and strings.Index over a constant table - the
  // shape that found the clobbered-block flag bug (memequal via shl %cl)
  try {
    writeFileSync('/tmp/breadth_gostrings.go', [
      'package main',
      'import ("fmt"; "strings"; "bytes")',
      'const t = "\\n\\tAR\\n\\tCC\\n\\tGOARCH\\n\\tGOFLAGS\\n\\tGOOS\\n\\tGOROOT\\n\\tPKG_CONFIG\\n"',
      'func main() {',
      '  for _, k := range []string{"GOOS", "AR", "GOARCH", "NOPE", "GO", "PKG_CONFIG"} { fmt.Println(k, strings.Contains(t, "\\t"+k+"\\n"), strings.Index(t, "\\t"+k+"\\n")) }',
      '  b := []byte(t); fmt.Println(bytes.IndexByte(b, \'P\'), bytes.Count(b, []byte("GO")), strings.LastIndex(t, "GO"), strings.EqualFold("goos", "GOOS"))',
      '}', ''].join('\n'));
    execFileSync('go', ['build', '-o', GOSTR, '/tmp/breadth_gostrings.go'],
      { cwd: '/tmp', env: { ...process.env, CGO_ENABLED: '0', GO111MODULE: 'off', GOCACHE: '/tmp/breadth_gocache', GOFLAGS: '-trimpath' } });
  } catch (e) { console.log('  (go build unavailable: ' + String(e.stderr || e.message).split('\n')[0] + ')'); }
}
const MADV = '/tmp/breadth_madv';
if (!existsSync(MADV)) {   // madvise(MADV_DONTNEED) reads back zeros (jemalloc's startup probe); mlock succeeds
  try { execFileSync('gcc', ['-O1', '-o', MADV, new URL('./fixtures/madv.c', import.meta.url).pathname]); } catch {}
}
const DLFAIL = '/tmp/breadth_dlfail';
if (!existsSync(DLFAIL)) {   // ld.so's longjmp error path under translation (failed dlsym/dlopen, 300x): javac died on it
  try { execFileSync('gcc', ['-O1', '-o', DLFAIL, new URL('./fixtures/dlfail.c', import.meta.url).pathname, '-ldl']); } catch {}
}
const CENSUS = '/tmp/breadth_census';
if (!existsSync(CENSUS)) {   // a census of less-common syscalls, each line name=ret/errno (tools/fixtures/census.c)
  try { execFileSync('gcc', ['-O1', '-o', CENSUS, new URL('./fixtures/census.c', import.meta.url).pathname]); } catch {}
}
const REPSCAN = '/tmp/breadth_repscan';
if (!existsSync(REPSCAN)) {   // rep scas/cmps flags (rcx=0 keeps them; pushf after a scan reads them) - the JVM's subtype check
  try { execFileSync('gcc', ['-O1', '-o', REPSCAN, new URL('./fixtures/repscan.c', import.meta.url).pathname]); } catch {}
}
const CENSUS2 = '/tmp/breadth_census2';
if (!existsSync(CENSUS2)) {  // the second census: processes, signals, sockets, memory (tools/fixtures/census2.c)
  try { execFileSync('gcc', ['-O1', '-o', CENSUS2, new URL('./fixtures/census2.c', import.meta.url).pathname]); } catch {}
}
if (!existsSync('/tmp/bgit/repo.git/info/refs')) {   // git-http's bare repo, dumb-protocol ready
  try { mkdirSync('/tmp/bgit', { recursive: true }); execFileSync('git', ['clone', '-q', '--bare', '/tmp/breadth_repo', '/tmp/bgit/repo.git']); execFileSync('git', ['update-server-info'], { cwd: '/tmp/bgit/repo.git' }); } catch {} }
if (!existsSync('/tmp/bh/hello.txt')) { try { mkdirSync('/tmp/bh', { recursive: true }); writeFileSync('/tmp/bh/hello.txt', 'hello over http\n'); } catch {} }   // http-loop's document root
const CENSUS3 = '/tmp/breadth_census3';
if (!existsSync(CENSUS3)) {  // the third census: filesystem edge cases, /proc shapes, timers, threads (tools/fixtures/census3.c)
  try { execFileSync('gcc', ['-O1', '-o', CENSUS3, new URL('./fixtures/census3.c', import.meta.url).pathname]); } catch {}
}
const PTYVIM = '/tmp/breadth_ptyvim';
if (!existsSync(PTYVIM)) {   // vim on a pty (tools/fixtures/ptyvim.c)
  try { execFileSync('gcc', ['-O1', '-o', PTYVIM, new URL('./fixtures/ptyvim.c', import.meta.url).pathname, '-lutil']); } catch {}
}
const PTYSH = '/tmp/breadth_ptysh';
if (!existsSync(PTYSH)) {    // an interactive bash on a pty, driven like a terminal (tools/fixtures/ptysh.c)
  try { execFileSync('gcc', ['-O1', '-o', PTYSH, new URL('./fixtures/ptysh.c', import.meta.url).pathname, '-lutil']); } catch {}
}
const CENSUS5 = '/tmp/breadth_census5';
if (!existsSync(CENSUS5)) {  // the fifth census: job control (stop/continue) and the tty line discipline (tools/fixtures/census5.c)
  try { execFileSync('gcc', ['-O1', '-o', CENSUS5, new URL('./fixtures/census5.c', import.meta.url).pathname]); } catch {}
}
const CENSUS4 = '/tmp/breadth_census4';
if (!existsSync(CENSUS4)) {  // the fourth census: System V IPC, POSIX mq, a pty, tee/splice, sessions, hardening probes, signal flags, statx (tools/fixtures/census4.c)
  try { execFileSync('gcc', ['-O1', '-o', CENSUS4, new URL('./fixtures/census4.c', import.meta.url).pathname, '-lutil']); } catch {}
}
const SOCKPAIR = '/tmp/breadth_sockpair';
if (!existsSync(SOCKPAIR)) {   // socketpair(AF_UNIX): both directions, EOF after the peer closes, a child on the other end
  try { execFileSync('gcc', ['-O1', '-o', SOCKPAIR, new URL('./fixtures/sockpair.c', import.meta.url).pathname]); } catch {}
}
const PSELECT = '/tmp/breadth_pselect';
if (!existsSync(PSELECT)) {   // pselect6/ppoll with a temporary signal mask, SIGCHLD blocked outside the wait (make -j's wait loop)
  try { execFileSync('gcc', ['-O1', '-o', PSELECT, new URL('./fixtures/pselect.c', import.meta.url).pathname]); } catch {}
}
const MAKEJ = '/tmp/breadth_make';
try {   // a three-target Makefile for make -j2: parallel recipes through sh, the jobserver pipe, pselect6 + SIGCHLD
  execFileSync('mkdir', ['-p', MAKEJ]);
  writeFileSync(MAKEJ + '/Makefile', [
    'all: a.txt b.txt c.txt', '\tcat a.txt b.txt c.txt | sort > all.txt', '\twc -l all.txt',
    'a.txt:', "\tseq 1 200 | sed 's/^/a /' > a.txt",
    'b.txt:', "\tseq 1 300 | awk '{print \"b\", $$1*2}' > b.txt",
    'c.txt:', "\tprintf 'c one\\nc two\\nc three\\n' > c.txt", ''].join('\n'));
  for (const f of ['a.txt', 'b.txt', 'c.txt', 'all.txt']) try { execFileSync('rm', ['-f', MAKEJ + '/' + f]); } catch {}
} catch {}
const RENAMEDIR = '/tmp/breadth_renamedir';
if (!existsSync(RENAMEDIR)) {   // rename(2) on directories, renameat2 NOREPLACE (rustc's incremental session finalisation)
  try { execFileSync('gcc', ['-O1', '-o', RENAMEDIR, new URL('./fixtures/renamedir.c', import.meta.url).pathname]); } catch {}
}
const RUST = '/root/.rustup/toolchains/stable-x86_64-unknown-linux-gnu';
const RHELLO = '/tmp/breadth_rhello';
if (!existsSync(RHELLO) && existsSync(RUST + '/bin/rustc')) {
  // Rust std: HashMap (SipHash, SSE2 probing), fmt, f64 parse/print, panic
  // machinery linked in; the binary is a PIE against libc + libgcc_s
  try {
    writeFileSync('/tmp/breadth_hello.rs', [
      'use std::collections::HashMap;',
      'fn main() {',
      '    let mut m: HashMap<String, usize> = HashMap::new();',
      '    let text = "the quick brown fox jumps over the lazy dog the fox";',
      '    for w in text.split_whitespace() { *m.entry(w.to_string()).or_insert(0) += 1; }',
      '    let mut v: Vec<_> = m.iter().collect();',
      '    v.sort();',
      '    for (k, c) in v { println!("{k}: {c}"); }',
      '    let s: f64 = (1..=1000).map(|i| (i as f64).sqrt()).sum();',
      '    println!("sum sqrt = {s:.6}");',
      '    let r: Result<u32, _> = "12x".parse::<u32>();',
      '    println!("{:?}", r.is_err());',
      '}', ''].join('\n'));
    execFileSync(RUST + '/bin/rustc', ['-O', '-o', RHELLO, '/tmp/breadth_hello.rs'], { cwd: '/tmp' });
  } catch (e) { console.log('  (rustc unavailable: ' + String(e.stderr || e.message).split('\n')[0] + ')'); }
}
const TINY_RS = '/tmp/breadth_tiny.rs';
if (!existsSync(TINY_RS)) writeFileSync(TINY_RS, [
  'pub fn fib(n: u32) -> u64 { if n < 2 { n as u64 } else { fib(n - 1) + fib(n - 2) } }',
  'fn main() { println!("{}", fib(20)); }', ''].join('\n'));
const CRATE = '/tmp/breadth_crate';
if (existsSync(RUST + '/bin/cargo')) {   // a no-dependency crate for `cargo build`; a stale target/ from the last native run must not be provisioned
  try {
    execFileSync('rm', ['-rf', CRATE + '/target']);
    execFileSync('mkdir', ['-p', CRATE + '/src']);
    writeFileSync(CRATE + '/Cargo.toml', '[package]\nname = "bc"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n');
    writeFileSync(CRATE + '/src/main.rs', 'fn fib(n: u32) -> u64 { if n < 2 { n as u64 } else { fib(n - 1) + fib(n - 2) } }\nfn main() { println!("fib(25) = {}", fib(25)); }\n');
  } catch {}
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
const BIGHEAP = '/tmp/breadth_bigheap';
if (!existsSync(BIGHEAP)) {
  try { execFileSync('gcc', ['-O1', '-o', BIGHEAP,
                             new URL('./fixtures/bigheap.c', import.meta.url).pathname]); } catch {}
}
const RLOCK = '/tmp/breadth_rlock';
if (!existsSync(RLOCK)) {
  try { execFileSync('gcc', ['-O1', '-o', RLOCK,
                             new URL('./fixtures/rlock.c', import.meta.url).pathname]); } catch {}
}
const SIGEVTHREAD = '/tmp/breadth_sigevthread';
if (!existsSync(SIGEVTHREAD)) {
  try { execFileSync('gcc', ['-O1', '-pthread', '-o', SIGEVTHREAD,
                             new URL('./fixtures/sigevthread.c', import.meta.url).pathname]); } catch {}
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
const FX = (n) => new URL('./fixtures/' + n, import.meta.url).pathname;   // a fixture's host path (== guest path)
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
const asm = makeAssembler({ tag: 'bw' });
const NOCACHE = !!process.env.BREADTH_NOCACHE;   // BREADTH_NOCACHE=1: every unit through wat2wasm (assembly-time A/Bs)
const assembleWat = (wat) => {
  const h = createHash('sha1').update(wat).digest('hex'), cp = CACHE + h + '.wasm';
  if (!NOCACHE && existsSync(cp)) return new Uint8Array(readFileSync(cp));
  const b = asm(wat);                              // pre-forked broker: the spawn is not paid from a multi-GB process
  if (!NOCACHE) try { writeFileSync(cp, b); } catch {}
  return b;
};
// deferred form: a cached unit answers at once, the rest come back from a pump
const assembleWatDeferred = (wat, cb) => {
  const h = createHash('sha1').update(wat).digest('hex'), cp = CACHE + h + '.wasm';
  if (!NOCACHE && existsSync(cp)) { cb(new Uint8Array(readFileSync(cp)), null); return; }
  asm.submit(wat, (b, e) => { if (b && !NOCACHE) try { writeFileSync(cp, b); } catch {} cb(b, e); });
};

// tree: provision a whole directory (an interpreter is not one file - without
// its stdlib CPython never reaches main, and the case would measure its own
// startup failure). Walked once per distinct tree.
const walked = new Set();
// Directory entries in the HOST's getdents order (fs.opendirSync; readdirSync
// sorts): the engine lists a directory in provisioning order, and zip, tar,
// find and `ls -U` archive or print in readdir order - zip's output differed
// from native's only in entry order until this matched.
const rawDir = (d) => { const dir = opendirSync(d), out = []; let e; while ((e = dir.readSync()) !== null) out.push(e.name); dir.closeSync(); return out; };
const walk = (d) => { if (walked.has(d)) return; walked.add(d);
  let e; try { e = rawDir(d); mtimes[d] = Math.floor(statSync(d).mtimeMs / 1000); } catch { return; }   // dirs carry mtimes too (ls -l)
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
  // ffmpeg: MMX/SSE DSP surface (emms after every SIMD call), worker threads,
  // 40 shared libraries; a synthetic source hashed by the md5 muxer
  ['unzip-l',  '/usr/bin/unzip', ['-l', ZIPF], { bins: [ZIPF] }],
  ['zip-dir',  '/usr/bin/zip',   ['-q', '-r', '-X', '-', ZIPDIR], { tree: ZIPDIR }],
  ['curl-file', '/usr/bin/curl', ['-s', 'file://' + ZIPDIR + '/sub/dlfail.c'], { tree: ZIPDIR }],
  ['ffprobe', '/usr/bin/ffprobe', ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=0.3:size=64x64:rate=10', '-show_streams', '-show_format'],
              { memMB: 2048, tree: '/usr/lib/x86_64-linux-gnu/pulseaudio' }],
  ['ffmpeg',  '/usr/bin/ffmpeg',  ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=0.3:size=64x64:rate=10', '-f', 'md5', '-'],
              { memMB: 2048, tree: '/usr/lib/x86_64-linux-gnu/pulseaudio' }],
  ['condwait',  '/tmp/breadth_condwait', []],
  ['gostrings', '/tmp/breadth_gostrings', [], { memMB: 2048 }],
  ['go-version', '/usr/local/go/bin/go', ['version'], { memMB: 2048, env: ['GOROOT=/usr/local/go', 'GOTELEMETRY=off'] }],
  // OpenJDK 21: the vsyscall page, pushf/popf, timed futex waits, fixed
  // mappings over holes, and glibc's PIC jump tables all fell out of it
  ['java-version', '/usr/lib/jvm/java-21-openjdk-amd64/bin/java', ['-Xint', '-XX:+UseSerialGC', '-Xshare:off', '-Xmx256m', '-version'],
              { memMB: 3072, tree: '/usr/lib/jvm/java-21-openjdk-amd64', execAnon: true }],   // the JVM's generated interpreter as code; java-hello stays without it
  ['java-hello', '/usr/lib/jvm/java-21-openjdk-amd64/bin/java', ['-Xint', '-XX:+UseSerialGC', '-Xshare:off', '-Xmx256m', '-cp', '/tmp/breadth_jhello', 'Hello'],
              { memMB: 3072, tree: ['/usr/lib/jvm/java-21-openjdk-amd64', '/tmp/breadth_jhello'] }],
  // javac compiling Hello.java on the -Xint JVM: ld.so's longjmp error path on
  // every failed dlsym, the JVM's generated interpreter as code (execAnon),
  // rep scans in the subtype check; the class file must match native javac's
  // the JVM with C1/C2 ON (no -Xint): compiled nmethods with ss:-prefixed
  // padding run in the interpreter, libjvm translated; NOT execAnon - HotSpot
  // patches call sites and inline caches in place, which no signal reports
  ['java-jit', '/usr/lib/jvm/java-21-openjdk-amd64/bin/java', ['-XX:+UseSerialGC', '-Xshare:off', '-Xmx256m', '-cp', '/tmp/breadth_jhello', 'Hello'],
              { memMB: 3072, tree: ['/usr/lib/jvm/java-21-openjdk-amd64', '/tmp/breadth_jhello'] }],
  ['javac',   '/usr/lib/jvm/java-21-openjdk-amd64/bin/javac', ['-J-Xint', '-J-XX:+UseSerialGC', '-J-Xshare:off', '-J-Xmx512m', '-d', '/tmp/breadth_javac', '/tmp/breadth_javac/Hello.java'],
              { memMB: 3072, tree: ['/usr/lib/jvm/java-21-openjdk-amd64', '/tmp/breadth_javac'], execAnon: true, outFile: '/tmp/breadth_javac/Hello.class' }],
  ['madv',    '/tmp/breadth_madv', []],
  ['dlfail',  DLFAIL, []],
  ['repscan', REPSCAN, []],
  ['census',  CENSUS, []],
  ['census2', CENSUS2, []],
  ['census3', CENSUS3, []],
  ['census4', CENSUS4, [], { bins: ['/bin/sh'] }],
  ['census5', CENSUS5, []],
  // an interactive bash on a pty, driven like a terminal: a background job,
  // jobs, kill %1, ^C to a foreground cat, ^Z stopping sleep, fg, $?, exit
  ['bash-pty', PTYSH, [], { bins: ['/bin/bash', '/usr/bin/sleep', '/usr/bin/cat'] }],
  // script(1): a pty, a forked shell, SIGCHLD through a signalfd, the transcript on stdout
  ['script-pty', '/usr/bin/script', ['-q', '-c', 'echo hi; printf "a\\tb\\n"', '/dev/null'], { bins: ['/bin/sh', '/usr/bin/echo', '/usr/bin/printf'] }],
  // vim on a pty (TERM=vt100, 24x80): open a file, insert a line, :wq; the terminal bytes and the file
  ['vim-pty', PTYVIM, [], { bins: ['/usr/bin/vim'], tree: '/usr/share/terminfo', memMB: 1024 }],
  // nasm assembling the recycle fixture's source: a flat binary out (outFile)
  ['nasm',    '/usr/bin/nasm', ['-f', 'bin', '-o', '/tmp/breadth_nasm.bin', new URL('./fixtures/recycle.asm', import.meta.url).pathname],
              { bins: [new URL('./fixtures/recycle.asm', import.meta.url).pathname], outFile: '/tmp/breadth_nasm.bin' }],
  ['sockpair', '/tmp/breadth_sockpair', []],
  ['renamedir', '/tmp/breadth_renamedir', []],
  ['pselect',  '/tmp/breadth_pselect', []],   // the wait's temporary mask, EINTR after the handler, the deadline dropped with it
  ['make-j2',  '/usr/bin/make', ['-j2', '-C', MAKEJ],
              { tree: MAKEJ, bins: ['/bin/sh', '/usr/bin/sh', '/usr/bin/cat', '/usr/bin/sort', '/usr/bin/wc', '/usr/bin/seq', '/usr/bin/sed', '/usr/bin/awk', '/usr/bin/printf'],
                outFile: MAKEJ + '/all.txt', childMemMB: 512 }],   // a vfork-window child's sigaction must not touch the parent's table   // directory rename, renameat2 NOREPLACE (rustc's incremental session finalisation)   // cargo spawns rustc over one (std's spawn error channel)
  ['rhello',  '/tmp/breadth_rhello', []],
  // rustc and clang: LLVM in-process (a 147 MB librustc_driver, libLLVM 118
  // MB), jemalloc's madvise probe, C++ exception tables; clang's output is
  // the whole -O2 pipeline compared as text
  ['rustc-version', RUST + '/bin/rustc', ['--version', '--verbose'], { memMB: 3072, tree: RUST + '/lib' }],
  ['clang-S', '/usr/bin/clang', ['-S', '-O2', '-o', '-', HELLO_C], { memMB: 2048 }],
  // cargo (libgit2, libcurl and OpenSSL linked in). `--verbose` also runs
  // lsb_release, a Python script natively, so its "os:" line is a
  // provisioning question rather than an engine one; the plain form is exact
  ['cargo-version', RUST + '/bin/cargo', ['--version'], { memMB: 2048, tree: RUST + '/lib' }],
  // The whole build tree in one case: cargo probes rustc over pipes, spawns
  // the compile over a socketpair error channel, rustc (7 threads) spawns cc
  // for the link, cc runs collect2, collect2 runs rustc's gcc-ld/ld.lld
  // wrapper, which runs rust-lld. The binary is compared to native's. 7.5
  // min cold. lto-wrapper must be present or gcc emits an empty
  // -plugin-opt= that rust-lld rejects.
  ['cargo-build', RUST + '/bin/cargo', ['build', '--offline', '--manifest-path', CRATE + '/Cargo.toml'],
              { memMB: 3072, childMemMB: 2048, env: ['RUSTC=' + RUST + '/bin/rustc'], nativeEnv: { RUSTC: RUST + '/bin/rustc' },
                tree: [RUST + '/lib', CRATE, '/usr/lib/gcc/x86_64-linux-gnu/13'],
                bins: [RUST + '/bin/rustc', '/usr/bin/cc', '/usr/bin/gcc', '/usr/bin/x86_64-linux-gnu-gcc-13',
                       '/usr/libexec/gcc/x86_64-linux-gnu/13/collect2', '/usr/libexec/gcc/x86_64-linux-gnu/13/lto-wrapper',
                       '/usr/libexec/gcc/x86_64-linux-gnu/13/liblto_plugin.so', '/usr/bin/ld', '/usr/bin/x86_64-linux-gnu-ld',
                       '/usr/bin/x86_64-linux-gnu-ld.bfd', '/usr/bin/as', '/usr/bin/x86_64-linux-gnu-as'],
                outFile: CRATE + '/target/debug/bc' }],
  // rustc optimising and emitting a crate in-process: seven threads, ~3,300
  // units, the PIC-table guard-vs-case-test bug fell out of it (450 s cold)
  ['rustc-asm', RUST + '/bin/rustc', ['-O', '--emit=asm', '--crate-type', 'bin', '-o', '/tmp/breadth_tiny.s', TINY_RS],
              { memMB: 3072, tree: RUST + '/lib', bins: [TINY_RS], outFile: '/tmp/breadth_tiny.s' }],
  ['gpg-md',  '/usr/bin/gpg',     ['--batch', '--print-md', 'SHA256', IN], { memMB: 1024 }],   // libgcrypt: mlock'd secure memory, a fresh ~/.gnupg
  ['xz',      '/usr/bin/xz',      ['-9', '-c', IN], { memMB: 1536 }],
  ['xz-1',    '/usr/bin/xz',      ['-1', '-c', IN]],
  ['gzip',    '/bin/gzip',        ['-9', '-c', IN]],
  ['diff',    '/usr/bin/diff',    ['-u', IN, IN]],
  ['sh',      '/bin/sh',          ['-c', 'echo start; for i in 1 2 3; do echo line $i; done; echo done']],
  ['rg',      '/usr/bin/rg',      ['--no-config', '-n', 'line 1', IN]],   // ripgrep (Rust): fstatat on dir fds with AT_EMPTY_PATH, NULL-path probes
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
  // node's net and dgram over the loopback (libuv: nonblocking connect, epoll
  // edge-triggered, 2 MB through an echo server with backpressure, EOF from a
  // server that closes first, a refused port, UDP, a unix-domain server)
  ['node-net','/opt/node22/bin/node', ['--jitless', new URL('./fixtures/net.js', import.meta.url).pathname],
              { memMB: 2048, bins: [new URL('./fixtures/net.js', import.meta.url).pathname] }],
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
  // python sockets, unmodified CPython: a TCP echo server on the loopback with
  // a client in another thread (70 KB through the pair, select), an AF_UNIX
  // stream server on a path, datagrams between two bound names, a pipe end
  // passed over a socketpair with SCM_RIGHTS
  ['python-sock', '/usr/bin/python3', ['-S', new URL('./fixtures/sock.py', import.meta.url).pathname],
                { tree: '/usr/lib/python3.11', bins: [new URL('./fixtures/sock.py', import.meta.url).pathname], memMB: 1024 }],
  // an HTTP server and its client in separate processes: python's http.server
  // (ThreadingHTTPServer: listen, poll, accept, a thread per request) in the
  // background, curl retried until it connects (the socket registry is shared
  // across the fork/exec tree), a 404, then kill and wait
  ['http-loop', '/bin/bash', ['-c', 'cd /tmp/bh && python3 -S -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1 & for i in $(seq 1 300); do curl -sf http://127.0.0.1:8765/hello.txt && break; sleep 0.2; done; curl -s -o /dev/null -w "%{http_code}\\n" http://127.0.0.1:8765/missing; kill %1; wait; echo rc=$?'],
                { tree: '/usr/lib/python3.11', bins: ['/tmp/bh/hello.txt', '/usr/bin/python3', '/usr/bin/curl', '/usr/bin/sleep', '/usr/bin/seq', '/usr/bin/kill'], memMB: 1024, childMemMB: 1024 }],
  // git over HTTP, three programs: python's http.server serves a bare repo
  // (dumb protocol: info/refs and loose objects), git clone runs
  // git-remote-http (libcurl) as a child to fetch them, then log and ls
  ['git-http', '/bin/bash', ['-c', 'cd /tmp/bgit && python3 -S -m http.server 8766 --bind 127.0.0.1 >/dev/null 2>&1 & for i in $(seq 1 300); do curl -sf -o /dev/null http://127.0.0.1:8766/repo.git/HEAD && break; sleep 0.2; done; rm -rf /tmp/bgit/out; git -c protocol.allow=always clone -q http://127.0.0.1:8766/repo.git /tmp/bgit/out 2>&1; cd /tmp/bgit/out && git log --oneline | head -3 && ls; kill %1; wait; echo rc=$?'],
                { tree: ['/usr/lib/python3.11', '/tmp/bgit/repo.git', '/usr/share/git-core/templates'],
                  bins: ['/usr/bin/python3', '/usr/bin/curl', '/usr/bin/sleep', '/usr/bin/seq', '/usr/bin/kill', '/usr/bin/rm', '/usr/bin/ls', '/usr/bin/head', '/usr/bin/git', '/usr/lib/git-core/git-remote-http', '/usr/lib/git-core/git'],
                  env: ['GIT_CONFIG_NOSYSTEM=1', 'GIT_EXEC_PATH=/usr/lib/git-core'], nativeEnv: { GIT_CONFIG_NOSYSTEM: '1', GIT_EXEC_PATH: '/usr/lib/git-core' }, memMB: 1024, childMemMB: 1024 }],
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
  // ruby fork + Process.wait + exit status: a fork in a multithreaded parent
  // (Ruby's timer thread) — the siblings must stay frozen during the window
  // ruby fork + Process.wait: a fork in a multithreaded parent whose child
  // creates its own thread inside the window (Ruby's timer thread) — that
  // thread belongs to the child and moves with it when it materialises
  ['ruby-fork', '/opt/ruby-3.3.6/bin/ruby', ['--disable-gems', '-e', 'p = fork { puts "child"; exit 4 }; Process.wait(p); puts "parent #{$?.exitstatus}"'],
                { memMB: 1024 }],
  // a 160MB heap in 64KB pieces: brk must stop at the mmap arena and glibc
  // must carry on from mmap - the heap that overran ld.so's link maps in vim
  ['bigheap',   BIGHEAP, []],                                  // 512MB guest: the 128MB gap is crossed, the fallback is exercised
  // POSIX record locks across fork (conflicts by range and type, the lock
  // dropped when any fd on the file closes, a blocking F_SETLKW released by
  // the parent) and OFD locks between two descriptions in one process
  ['rlock',     RLOCK, []],
  // timer_create(SIGEV_THREAD): glibc's helper thread, SIGEV_THREAD_ID
  // delivery of SIGTIMER to it, the callback thread per expiry
  ['sigevthread', SIGEVTHREAD, []],
  // ---- batch 4: text tools, build tools, an editor and a debugger in batch mode
  // m4: macro expansion with recursion, eval, regexp, esyscmd (fork+exec of
  // sh inside a filter), diversions
  ['m4',        '/usr/bin/m4', [FX('prog.m4')], { bins: [FX('prog.m4'), '/bin/sh', '/usr/bin/printf'] }],
  // bison: an LALR(1) parser generator writing its output file
  ['bison',     '/usr/bin/bison', ['-o', '/tmp/breadth_calc.c', FX('calc.y')],
                { bins: [FX('calc.y'), '/usr/bin/m4'], tree: '/usr/share/bison', outFile: '/tmp/breadth_calc.c' }],   // bison runs its skeletons through m4 (execve'd)
  // vim in ex (silent batch) mode: a substitution and a sort over IN, written out
  ['vim-es',    '/usr/bin/vim', ['-es', '-u', 'NONE', '-i', 'NONE', '-c', '%s/e/E/g', '-c', '%!sort', '-c', 'w! /tmp/breadth_vim.txt', '-c', 'q!', IN],
                { bins: ['/usr/bin/sort', '/usr/bin/sh'], outFile: '/tmp/breadth_vim.txt' }],   // vim's filter runs through /usr/bin/sh (its compiled-in 'shell'), an absolute path
  // ninja: dry-run of a three-edge graph in dependency order
  ['ninja',     '/usr/bin/ninja', ['-n', '-f', FX('build.ninja')], { bins: [FX('build.ninja')] }],
  // cmake script mode: lists, math, regex, file write+read
  ['cmake-P',   '/bin/bash', ['-c', 'mkdir -p /tmp/bcm && cmake -P ' + FX('script.cmake') + ' 2>&1'],
                { bins: ['/usr/bin/cmake', '/usr/bin/mkdir', FX('script.cmake')], tree: '/usr/share/cmake-3.28' }],
  // gdb in batch mode over a real binary: symbol lookup and disassembly of main
  ['gdb-batch', '/usr/bin/gdb', ['-batch', '-nx', '-ex', 'info functions ^main$', '-ex', 'disassemble main', '/tmp/breadth_thread'],
                { bins: ['/tmp/breadth_thread'], tree: '/usr/lib/python3.12', memMB: 1024 }],   // gdb embeds CPython and initialises it at startup: it needs the stdlib tree
  // split into fixed-line pieces; the second piece is the file compared
  ['split',     '/usr/bin/split', ['-l', '400', '-d', IN, '/tmp/breadth_split_'], { outFile: '/tmp/breadth_split_01' }],
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
const native = (bin, args, stdin, nativeEnv) => {
  try { const out = execFileSync(bin, args, { input: stdin, maxBuffer: 1 << 28, ...(nativeEnv ? { env: { ...process.env, ...nativeEnv } } : {}) });
        return { out, code: 0 }; }
  catch (e) { return { out: e.stdout ?? Buffer.alloc(0),
                       code: e.status ?? (e.signal ? 128 + (SIGN[e.signal] || 0) : -1) }; }
};

const engine = (bin, args, stdin, opts = {}) => {
  add(bin, bin);
  const eng = new LinuxEngine(new Uint8Array(readFileSync(bin)),
    { argv: [bin, ...args], env: ['PATH=/usr/bin:/bin', 'HOME=/root', 'LANG=C', ...(opts.env || [])],
      files, mtimes, memMB: opts.memMB || 512, assembleWat, stdin });

  if (process.env.BREADTH_STRACE) eng.strace = [];
  if (process.env.ASYNC_ASM !== '0') { eng.assembleWatDeferred = assembleWatDeferred; eng.pumpAsm = () => asm.pump(); }   // deferred assembly, default since the 182-case sweep under it was green; ASYNC_ASM=0 assembles synchronously (A/B)
  if (opts.childMemMB) eng.childMemMB = opts.childMemMB;   // execve'd children (default 256 MB; a rustc child needs more)
  if (opts.execAnon) eng.execAnon = true;   // anonymous PROT_EXEC mappings count as code (a JIT's code cache: the JVM's template interpreter)
  if (process.env.AOTFAIL) eng.onAotFail = (a, m) => {   // AOTFAIL=1: every refused translation with its reason; an overlap also shows the bytes and the image
    let extra = '';
    const ov = /overlapping decode: ([0-9a-f]+) inside ([0-9a-f]+)/.exec(String(m));
    if (ov) { try { const at = BigInt('0x' + ov[2]); const bs = []; for (let i = 0n; i < 12n; i++) bs.push(Number(eng.mem.read(at + i, 1n)).toString(16).padStart(2, '0'));
      const mp = (eng.maps || []).find(x => at >= x.at && at < x.at + x.len);
      extra = ` bytes ${bs.join(' ')}${mp ? ' in ' + mp.path.split('/').pop() + '+' + (at - mp.at + BigInt(mp.fileOff)).toString(16) : ''}`; } catch {} }
    console.log(`         <aotfail ${a.toString(16)}: ${String(m).slice(0, 160)}${extra}>`);
  };
  const t0 = process.hrtime.bigint();
  let err = null;
  try {
    let guard = 0;
    // A blocked engine with a future deadline is WAITING (nanosleep, an
    // itimer, a poll timeout): sleep until then like a real host would,
    // instead of spinning through the guard in a few ms of wall time.
    const nap = new Int32Array(new SharedArrayBuffer(4));
    // The guard counts host iterations that did work; a parent and child
    // that are both blocked with short deadlines make every iteration a nap
    // and would spin forever - a wall-clock cap is the backstop.
    let iter = 0; const T0 = performance.now(), wallMs = (opts.wallS ?? 900) * 1000;
    while (eng.exitCode === null) {
      eng.run(5e7);
      if (performance.now() - T0 > wallMs) { err = `no exit within ${wallMs / 1000}s wall`; break; }
      // BREADTH_PROGRESS=N: every N host iterations print each engine's
      // threads and syscall tail (BREADTH_STRACE=1 arms the rings; children
      // inherit them) - what read the ruby-fork mutual wait
      if (process.env.BREADTH_PROGRESS) {
        if ((++iter % +process.env.BREADTH_PROGRESS) === 0) {
          console.error(`<it ${iter} interp=${eng.stats.interpreted} aot=${eng.stats.aotRuns} blocked=${eng.blocked ? (eng.blocked.deadline == null ? 'null' : (eng.blocked.deadline - eng.nowMs()).toFixed(0) + 'ms') : 'no'} thr=${eng.threads.map(t => t.id + ':' + t.state + (t.futex ? '@' + t.futex.toString(16) : '')).join(' ')} rip=${eng.cpu.rip.toString(16)} strace=[${(eng.strace || []).slice(-4).join(' | ')}]>`);
          for (const c of eng.children ?? []) if (c.eng && c.exited === null)
            console.error(`   child ${c.pid}: blocked=${JSON.stringify(c.eng.blocked)} thr=${c.eng.threads.map(t => t.id + ':' + t.state + (t.futex ? '@' + t.futex.toString(16) : '')).join(' ')} rip=${c.eng.cpu.rip.toString(16)} interp=${c.eng.stats.interpreted} strace=[${(c.eng.strace || []).slice(-6).join(' | ')}]`);
        }
      }
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
           units: eng.aotFns.size, insns: eng.stats.interpreted, err,
           yields: `${eng.stats.loopYieldTop | 0}/${eng.stats.loopYieldNested | 0}/${eng.stats.loopHot | 0}` };   // top-level yields / nested (deopt) yields / units rooted on request
};

let pass = 0, fail = 0;
const failures = [];
for (const [name, bin, args, opts] of CASES) {
  if (!pick(name)) continue;
  // V8 does not collect a finished case's wasm memory on its own pressure
  // accounting: without this a chunk of 50 cases grew to 13.7 GB and was
  // OOM-killed (run with --expose-gc; a no-op without it)
  if (globalThis.gc) globalThis.gc();
  if (!existsSync(bin)) { console.log(`  SKIP ${name.padEnd(9)} (${bin} not present)`); continue; }
  const stdin = STDIN[name] || null;
  if (opts && opts.tree) for (const t of [].concat(opts.tree)) walk(t);
  if (opts && opts.bins) for (const b of opts.bins) add(b, b);   // child-exec binaries
  const nat = native(bin, args, stdin, opts && opts.nativeEnv);   // nativeEnv: variables the native oracle needs too (cargo's RUSTC)
  // outFile case: native wrote the file to the real FS; read it as the oracle
  if (opts && opts.outFile) { try { nat.out = readFileSync(opts.outFile); } catch { nat.out = Buffer.alloc(0); } }
  const eng = engine(bin, args, stdin, opts);
  // compare the bytes, not a summary: a truncated stdout that happens to
  // share a prefix is exactly the failure a length check alone would miss
  const same = eng.code === nat.code && Buffer.compare(eng.out, nat.out) === 0;
  if (same) { pass++;
    console.log(`  ok   ${name.padEnd(9)} ${String(nat.out.length).padStart(8)}B out, ` +
                `${eng.units} fns, ${(eng.ms).toFixed(0)}ms yields=${eng.yields}`);
    if (process.env.BREADTH_STDERR && eng.stderr) console.log(`         guest stderr: ${JSON.stringify(eng.stderr.slice(0, 600))}`);   // BREADTH_STDERR=1: show it on success too (warnings the byte compare cannot see)
    if (process.env.BREADTH_MEM) {   // guest-written entries whose bytes live inside a wasm memory would pin that memory for the rest of the run
      const big = Object.entries(files).filter(([k, v]) => v && v.buffer && v.buffer.byteLength > (64 << 20) && v.byteLength < v.buffer.byteLength).map(([k, v]) => `${k}(${v.byteLength}B in a ${(v.buffer.byteLength / 1e6) | 0}MB buffer)`);
      if (big.length) console.log(`         file entries viewing large buffers: ${big.length}: ${big.slice(0, 6).join(' ')}`);
    }
    if (process.env.BREADTH_MEM) { const m = process.memoryUsage(); console.log(`         host rss ${(m.rss / 1e6) | 0}MB heap ${(m.heapUsed / 1e6) | 0}MB ext ${(m.external / 1e6) | 0}MB ab ${(m.arrayBuffers / 1e6) | 0}MB`); }   // BREADTH_MEM=1: host memory after each case (a chunk was OOM-killed at 13.7 GB)
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
    if (eng.strace && process.env.BREADTH_STRACE_FILE) writeFileSync(process.env.BREADTH_STRACE_FILE, eng.strace.join('\n'));   // the whole trace of a failing case
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

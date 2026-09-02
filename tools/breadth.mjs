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

// A C source for the compiler cases, written once like IN.
const HELLO_C = '/tmp/breadth_hello.c';
if (!existsSync(HELLO_C))
  writeFileSync(HELLO_C, 'int main(){__builtin_printf("hi from compiled C\\n");return 0;}\n');
add(HELLO_C, HELLO_C);

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
  let e; try { e = readdirSync(d); } catch { return; }
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
  // the compiler lane: gcc's driver vforks cc1 (the case that drove the
  // interpUntil-depth fork fix); assembly comes back on stdout. Preprocessor,
  // front end and back end of a 30MB binary, byte-compared to native.
  ['gcc-S', '/usr/bin/gcc', ['-S', '-o', '-', '-O1', HELLO_C],
            { bins: ['/usr/libexec/gcc/x86_64-linux-gnu/13/cc1'],
              tree: ['/usr/include', '/usr/lib/gcc/x86_64-linux-gnu/13/include'],
              memMB: 1024 }],
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
    while (eng.exitCode === null) {
      eng.run(5e7);
      if (eng.blocked) eng.wake();
      if (++guard > 4000) { err = 'no exit after 200e9 steps'; break; }
    }
  } catch (e) { err = e.message; }
  // stdoutBytes, not stdout: the string view mangles binary output, and
  // comparing it reported gzip as differing from byte 1 when the bytes were
  // fine. A generality harness that corrupts its own evidence is worse than
  // none.
  const raw = eng.stdoutBytes && eng.stdoutBytes.length
    ? Buffer.concat(eng.stdoutBytes.map(b => Buffer.from(b)))
    : Buffer.from(eng.stdout.join(''), 'binary');
  return { out: raw, code: eng.exitCode, stderr: (eng.stderr || []).join(''),
           unknown: [...(eng.unknown || [])], strace: eng.strace,
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
  const eng = engine(bin, args, stdin, opts);
  // compare the bytes, not a summary: a truncated stdout that happens to
  // share a prefix is exactly the failure a length check alone would miss
  const same = eng.code === nat.code && Buffer.compare(eng.out, nat.out) === 0;
  if (same) { pass++;
    console.log(`  ok   ${name.padEnd(9)} ${String(nat.out.length).padStart(8)}B out, ` +
                `${eng.units} fns, ${(eng.ms).toFixed(0)}ms`); }
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

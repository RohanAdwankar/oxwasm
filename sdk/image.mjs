// The sandbox's filesystem image: exactly the files the guest can reach.
//
// The first version of this read every library on the host into memory for
// every sandbox - 677 files, 1,073 MB on a machine with ffmpeg installed - to
// run a python that needs 3.4 MB of them. A sandbox that costs a gigabyte
// before it runs a line is not the cheap thing being sold, and the number
// scaled with whatever else happened to be installed. So the image is a
// dependency closure: the interpreter, its standard library, the packages the
// caller mounts, a short list of command-line tools, and the shared libraries
// `ldd` says each of those loads - nothing else.
import { readFileSync, readdirSync, lstatSync, realpathSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';

export const CACHE_DIR = process.env.OXWASM_CACHE || join(homedir(), '.cache', 'oxwasm');

// Tools `commands.run` expects to find. Each is provisioned only if the host
// has it; the shell is the one that has to be there.
export const DEFAULT_COMMANDS = [
  'sh', 'dash', 'bash', 'ls', 'cat', 'echo', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'pwd', 'env', 'true', 'false',
  'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'tee', 'grep', 'sed', 'awk', 'find', 'xargs', 'basename',
  'dirname', 'printf', 'sleep', 'date', 'uname', 'id', 'whoami', 'chmod', 'ln', 'stat', 'readlink', 'realpath',
  'du', 'df', 'diff', 'tar', 'gzip', 'gunzip', 'zcat', 'test', '[', 'seq', 'yes', 'expr', 'od', 'md5sum',
  'sha256sum', 'base64', 'kill',
];

// ---- ldd, memoised on disk ------------------------------------------------
let lddMemo = null;
const memoPath = join(CACHE_DIR, 'ldd.json');
function loadMemo() {
  if (lddMemo) return lddMemo;
  try { lddMemo = JSON.parse(readFileSync(memoPath, 'utf8')); } catch { lddMemo = {}; }
  return lddMemo;
}
function saveMemo() {
  try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(memoPath, JSON.stringify(lddMemo)); } catch {}
}

const isElf = (p) => {
  try {
    const fd = readFileSync(p, { encoding: null, flag: 'r' }).subarray(0, 4);
    return fd[0] === 0x7f && fd[1] === 0x45 && fd[2] === 0x4c && fd[3] === 0x46;
  } catch { return false; }
};

/** Shared libraries `path` loads, as the logical paths ldd prints. */
export function libsOf(path) {
  const memo = loadMemo();
  let st; try { st = statSync(path); } catch { return []; }
  const key = `${path}:${st.size}:${Math.floor(st.mtimeMs)}`;
  if (memo[key]) return memo[key];
  const libs = [];
  try {
    const out = execFileSync('ldd', [path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of out.split('\n')) {
      const m = /=>\s*(\/\S+)/.exec(line) || /^\s*(\/\S+)\s+\(0x/.exec(line);
      if (m) libs.push(m[1]);
    }
  } catch { /* static, or not loadable by ldd: it has no closure to add */ }
  memo[key] = libs;
  return libs;
}

// ---- the image ---------------------------------------------------------------
const bytesOf = new Map();                       // realpath -> Uint8Array, shared by every image in this thread
function load(real) {
  let b = bytesOf.get(real);
  if (!b) { b = new Uint8Array(readFileSync(real)); bytesOf.set(real, b); }
  return b;
}

// A merged-/usr host answers /lib and /usr/lib with the same directory, and a
// dynamic loader may ask for either spelling.
function spellings(p) {
  const out = [p];
  if (p.startsWith('/lib/')) out.push('/usr' + p);
  else if (p.startsWith('/usr/lib/')) out.push(p.slice(4));
  else if (p.startsWith('/lib64/')) out.push('/usr' + p);
  else if (p.startsWith('/bin/')) out.push('/usr' + p);
  else if (p.startsWith('/usr/bin/')) out.push(p.slice(4));
  return out;
}

// Directories under a standard library that are never imported by running code.
const STDLIB_SKIP = new Set(['test', 'tests', 'idlelib', 'tkinter', 'turtledemo', 'lib2to3', 'ensurepip']);

/**
 * The stdlib has to be the one THIS interpreter was built for: a host can carry
 * several (this one has 3.10 through 3.13), and handing CPython the wrong one
 * fails before it runs a line with "No module named 'encodings'".
 */
export function findPythonTree(bin) {
  let ver = null;
  try { ver = (/python(3(?:\.\d+)?)$/.exec(realpathSync(bin)) || [])[1] || null; } catch {}
  const cands = [];
  for (const d of ['/usr/lib', '/usr/local/lib']) {
    if (ver) cands.push(join(d, 'python' + ver));
    let e; try { e = readdirSync(d); } catch { continue; }
    for (const f of e.sort().reverse()) if (/^python3\.\d+$/.test(f)) cands.push(join(d, f));
  }
  for (const c of cands) if (existsSync(join(c, 'encodings', '__init__.py'))) return c;
  throw new Error(`no python3 standard library found for ${bin}` + (ver ? ` (wanted python${ver})` : ''));
}

function which(name) {
  for (const d of (process.env.PATH || '/usr/bin:/bin').split(':')) {
    const p = join(d, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * @returns {{files: Record<string, Uint8Array>, mtimes: Record<string, number>, stats: object}}
 */
export function buildImage({ python = '/usr/bin/python3', packages = [], commands = DEFAULT_COMMANDS, extraFiles = {}, network = null } = {}) {
  if (!existsSync(python)) throw new Error(`${python} not found on this host`);
  const files = {}, mtimes = {};
  const elfs = new Set();                        // real paths whose library closure is needed
  const want = new Set();                        // logical paths of libraries to provision
  let nFiles = 0;

  const put = (guest, host) => {
    let real; try { real = realpathSync(host); } catch { return false; }
    let st; try { st = statSync(real); } catch { return false; }
    if (!st.isFile()) return false;
    const b = load(real);
    for (const g of spellings(guest)) { files[g] = b; mtimes[g] = Math.floor(st.mtimeMs / 1000); }
    nFiles++;
    return true;
  };

  // the interpreter, at the path argv[0] will name
  put(python, python);
  elfs.add(realpathSync(python));

  const walk = (dir, skip) => {
    let e; try { e = readdirSync(dir); } catch { return; }
    for (const f of e) {
      const p = join(dir, f);
      let st; try { st = lstatSync(p); } catch { continue; }
      if (st.isDirectory()) { if (!(skip && skip.has(f))) walk(p, skip); continue; }
      if (put(p, p) && /\.so(\.|$)/.test(f)) elfs.add(realpathSync(p));
    }
  };
  walk(findPythonTree(python), STDLIB_SKIP);
  for (const pkg of packages) walk(pkg, null);

  // command-line tools
  const provisioned = [];
  for (const name of commands) {
    const host = which(name);
    if (!host) continue;
    if (put('/bin/' + name, host)) {
      provisioned.push(name);
      const real = realpathSync(host);
      if (isElf(real)) elfs.add(real);
    }
  }

  // name resolution: glibc loads its NSS modules with dlopen, so ldd never lists them
  if (network) {
    for (const dir of ['/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu', '/lib64']) {
      for (const m of ['libnss_files.so.2', 'libnss_dns.so.2', 'libresolv.so.2']) {
        const p = join(dir, m);
        if (existsSync(p) && put(p, p)) { elfs.add(realpathSync(p)); }
      }
    }
    // trust what the host trusts: its bundle, which on a host behind a TLS-inspecting proxy includes the proxy's CA
    const bundle = [process.env.SSL_CERT_FILE, '/etc/ssl/certs/ca-certificates.crt'].find((f) => f && existsSync(f));
    if (bundle) put('/etc/ssl/certs/ca-certificates.crt', bundle);
    for (const f of ['/etc/protocols', '/etc/services']) put(f, f);
    const enc = (t) => new TextEncoder().encode(t);
    extraFiles = {
      ...extraFiles,
      '/etc/resolv.conf': enc(network.resolvers.map((r) => `nameserver ${r}\n`).join('') + 'options timeout:3 attempts:2\n'),
      '/etc/hosts': enc('127.0.0.1 localhost\n::1 localhost\n'),
      '/etc/nsswitch.conf': enc('passwd: files\ngroup: files\nhosts: files dns\nnetworks: files\nprotocols: files\nservices: files\n'),
    };
  }

  // the shared libraries all of that loads
  for (const real of elfs) for (const l of libsOf(real)) want.add(l);
  for (const l of want) put(l, l);
  saveMemo();

  for (const f of ['/etc/ld.so.cache', '/etc/passwd', '/etc/group']) put(f, f);
  for (const [g, b] of Object.entries(extraFiles)) { files[g] = b; mtimes[g] = 1; }

  return { files, mtimes, stats: { files: nFiles, libs: want.size, commands: provisioned } };
}

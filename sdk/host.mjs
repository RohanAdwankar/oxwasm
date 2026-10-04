// Owns one guest CPython: boots it (from a snapshot when there is one), frames
// the request/response protocol over its stdin/stdout, and steps the engine in
// bounded slices so whoever drives it stays responsive.
//
// This runs inside a worker thread (see worker.mjs), which is what makes the
// rest of the SDK safe to put in front of untrusted code: a guest that spins
// in compiled code never returns from a slice, and only a separate thread can
// be abandoned when that happens.
import { makeNet } from './net.mjs';
import { loadRootfs, resolveIn } from './rootfs.mjs';
import { readFileSync, statSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { LinuxEngine } from '../engine/linux.mjs';
import { CPU } from '../engine/interp.mjs';
import { snapshotEngine, restoreEngine } from '../engine/snapshot.mjs';
import { makeAssembler } from '../tools/assemble.mjs';
import { makeInProcessAssembler, withNativeFallback } from './wabt-asm.mjs';
import { buildImage, findPythonTree, CACHE_DIR, DEFAULT_COMMANDS } from './image.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const GUEST_PATH = '/oxwasm/guest.py';
export const SLICE_MS = 40;                       // how long the guest may hold the thread at a stretch

const sha = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest('hex').slice(0, 20); };

// A snapshot is only valid for the exact machine it was taken on: the same
// interpreter, the same mounted packages, the same tools, the same driver and
// the same engine. Anything else must miss.
function cacheKey({ python, packages, commands, memMB, network, rootfs, cpuV2, cpus }, guestSrc) {
  const engine = [...['linux.mjs', 'aot_wat.mjs', 'interp.mjs', 'decode.mjs', 'snapshot.mjs', 'snapshot_core.mjs']
    .map((f) => sha(readFileSync(join(HERE, '..', 'engine', f)))),
    // the SDK's own code decides what goes into a snapshot (the warm-up, the unit capture)
    ...['host.mjs', 'image.mjs', 'net.mjs'].map((f) => sha(readFileSync(join(HERE, f))))];
  const stamp = (p) => { try { const s = readFileSync(p).length; return `${p}:${s}`; } catch { return p; } };
  const rootHash = rootfs ? sha(readFileSync(rootfs)) : null;
  // a rootfs image brings its own Python: nothing about the host's belongs in the key
  return sha(JSON.stringify({ python: rootfs ? null : stamp(python), tree: rootfs ? null : findPythonTree(python), memMB, cpuV2: !!cpuV2, cpus: cpus || 1,
                              packages: [...packages].sort(), commands: [...commands].sort(), network, rootHash, engine }), guestSrc);
}

// A disk store of finished compiled units, shared by every program the sandbox runs and every later run:
// <cache>/units/<engine hash>/<program id>/<entry hex>.wasm. The engine decides what is safe to put in it (units
// confined to the program's static image) and keys it by a hash of that image; here it is only files.
let _engineHash = null;
const engineHash = () => _engineHash ??= sha(...['linux.mjs', 'aot_wat.mjs', 'interp.mjs', 'decode.mjs'].map((f) => readFileSync(join(HERE, '..', 'engine', f))), process.version, process.env.OXWASM_FNVETO_FILE ? readFileSync(process.env.OXWASM_FNVETO_FILE) : '', process.env.OXWASM_FNALLOW_FILE ? readFileSync(process.env.OXWASM_FNALLOW_FILE) : '');
function makeUnitStore(cacheDir) {
  const root = join(cacheDir, 'units', engineHash());
  return {
    digest(chunks) { const h = createHash('sha1'); for (const c of chunks) h.update(c); return h.digest('hex').slice(0, 16); },
    exeId(chunks, extra) { const h = createHash('sha1'); for (const c of chunks) h.update(c); h.update(String(extra)); return h.digest('hex').slice(0, 20); },
    get(ex, k) { try { const b = readFileSync(join(root, ex, k + '.wasm')); if (process.env.OXWASM_UNITLOG) console.error('[unitstore hit]', ex, k); return new Uint8Array(b.buffer, b.byteOffset, b.length); } catch { if (process.env.OXWASM_UNITLOG) console.error('[unitstore miss]', ex, k); return undefined; } },
    put(ex, k, bytes) {
      const d = join(root, ex); mkdirSync(d, { recursive: true });
      const f = join(d, k + '.wasm'), t = f + '.' + process.pid + '.tmp';
      writeFileSync(t, bytes); renameSync(t, f);
    },
  };
}

// units.bin: one JSON line [[entryHex, byteLength], ...] then the wasm modules back to back.
function saveUnits(path, units) {
  const keys = [...units.keys()];
  const head = Buffer.from(JSON.stringify(keys.map((k) => [k.toString(16), units.get(k).length])) + '\n');
  writeFileSync(path, Buffer.concat([head, ...keys.map((k) => Buffer.from(units.get(k)))]));
}

function loadUnits(path, eng) {
  if (!existsSync(path)) return 0;
  const raw = readFileSync(path);
  const nl = raw.indexOf(10);
  const index = JSON.parse(raw.subarray(0, nl).toString());
  const map = new Map();
  let off = nl + 1;
  for (const [hex, len] of index) { map.set(hex, new Uint8Array(raw.buffer, raw.byteOffset + off, len)); off += len; }
  eng.unitBytes = (k) => map.get(k.toString(16));
  return map.size;
}

export class EngineHost {
  constructor() {
    this.eng = null; this.pipe = null; this.buf = Buffer.alloc(0);
    this.onFrame = () => {};
    this.bootInfo = null;
  }

  /**
   * @param {object} o  python, packages, commands, memMB, cache (bool), log(fn)
   */
  static async boot(o = {}) {
    const host = new EngineHost();
    const python = o.python || '/usr/bin/python3';
    const packages = o.packages || [];
    const commands = o.commands || DEFAULT_COMMANDS;
    const memMB = o.memMB || 512;
    const useCache = o.cache !== false;
    const guestSrc = readFileSync(join(HERE, 'guest.py'));

    const t0 = performance.now();
    const netp = o.network ? makeNet(o.network) : null;
    const caBundle = o.network && typeof o.network === 'object' ? o.network.caBundle : null;
    let image, pythonPath = python;
    if (o.rootfs) {
      // the filesystem is the tarball: its own python, its own libraries, a real dpkg database
      const r = loadRootfs(o.rootfs);
      const enc = (t) => new TextEncoder().encode(t);
      r.files[GUEST_PATH] = new Uint8Array(guestSrc);
      if (netp) {
        r.files['/etc/resolv.conf'] = enc(netp.resolvers.map((x) => `nameserver ${x}\n`).join('') + 'options timeout:3 attempts:2\n');
        r.files['/etc/hosts'] = enc('127.0.0.1 localhost\n::1 localhost\n');
        // extra trust: a bundle to use instead of the image's (for hosts behind a TLS-inspecting proxy)
        if (caBundle) r.files['/etc/ssl/certs/ca-certificates.crt'] = new Uint8Array(readFileSync(caBundle));
      }
      pythonPath = resolveIn(r, o.python || '/usr/bin/python3');
      // the engine reads the ELF interpreter straight out of `files`, before any symlink table exists
      { const ld = '/lib64/ld-linux-x86-64.so.2', real = resolveIn(r, ld); if (!r.files[ld] && r.files[real]) r.files[ld] = r.files[real]; }
      image = { files: r.files, mtimes: r.mtimes, meta: r, stats: { files: Object.keys(r.files).length, rootfs: o.rootfs } };
    } else {
      image = buildImage({ python, packages, commands, extraFiles: { [GUEST_PATH]: new Uint8Array(guestSrc) },
                           network: netp ? { resolvers: netp.resolvers } : null });
    }
    const tImage = performance.now() - t0;

    // The compiled tier needs an assembler. wabt in this thread by default: no binary on PATH, no
    // child process. `assembler: 'wat2wasm'` keeps the native tool and its broker processes.
    let asm = null;
    if (o.assembler !== 'wat2wasm') {
      try { asm = withNativeFallback(await makeInProcessAssembler(), () => makeAssembler({ tag: 'oxsb', debugNames: !!process.env.OXWASM_DEBUGNAMES })); }
      catch (e) { o.log?.(`in-process assembler unavailable (${e.message}); using wat2wasm`); }
    }
    if (!asm) {
      try { asm = makeAssembler({ tag: 'oxsb', debugNames: !!process.env.OXWASM_DEBUGNAMES }); }
      catch (e) { throw new Error(`sandbox: ${e.message}`); }
    }

    // Assembled units are cached by content hash across runs. A restored
    // snapshot drops the compiled tier and re-heats it, and without this each
    // unit pays a wat2wasm process to come back: the first cells after a
    // restore took 4.8 s, 4.0 s and 1.8 s against ~200 ms once hot.
    const wdir = join(CACHE_DIR, 'wat');
    try { mkdirSync(wdir, { recursive: true }); } catch {}
    const wpath = (wat) => join(wdir, createHash('sha1').update(wat).digest('hex') + '.wasm');
    const assembleWat = (wat) => {
      const cp = wpath(wat);
      if (existsSync(cp)) return new Uint8Array(readFileSync(cp));
      const b = asm(wat);
      try { writeFileSync(cp, b); } catch {}
      return b;
    };
    const assembleWatDeferred = (wat, cb) => {
      const cp = wpath(wat);
      if (existsSync(cp)) { cb(new Uint8Array(readFileSync(cp)), null); return; }
      asm.submit(wat, (b, e) => { if (b) try { writeFileSync(cp, b); } catch {} cb(b, e); });
    };

    let unitStore = null;
    const make = () => {
      const eng = new LinuxEngine(image.files[pythonPath], {
        argv: [python, '-S', '-B', GUEST_PATH],
        env: [o.rootfs ? 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' : 'PATH=/usr/bin:/bin', 'HOME=/root', 'LANG=C.UTF-8', 'PYTHONDONTWRITEBYTECODE=1', 'PYTHONUNBUFFERED=1',
              ...(packages.length ? [`PYTHONPATH=${packages.join(':')}`] : []),
              // glibc would otherwise pick its SSSE3/SSE4.2 string routines on a v2 CPU
              ...(netp ? ['SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt', 'REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt', 'CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt'] : []),
              ...(packages.length || o.cpuV2 ? ['GLIBC_TUNABLES=glibc.cpu.hwcaps=-SSSE3,-SSE4_1,-SSE4_2,-POPCNT'] : []), ...(o.env || [])],
        files: image.files, mtimes: image.mtimes, memMB, assembleWat, net: netp, diskMB: o.diskMB ?? 1024,
      });
      eng.assembleWatDeferred = assembleWatDeferred;
      if (o.unitCache !== false) { try { eng.unitStore = unitStore ??= makeUnitStore(CACHE_DIR); } catch {} }   // compiled units persist across runs and programs
      // exec'd programs: the child engines default to browser-sized units (24 functions, 4,000 instructions, for wabt.js);
      // a Node host assembles in-process or with wat2wasm and can take real hot functions
      eng.childUnitMaxFuncs = o.unitMaxFuncs ?? 96; eng.childUnitMaxInsns = o.unitMaxInsns ?? 30000;
      if (o.cpus) eng.ncpu = o.cpus;                     // CPUs the guest sees (default 1): runtimes size their thread pools from it
      if (o.childMemMB) eng.childMemMB = o.childMemMB;   // RAM for each exec'd program (default 256 MB): large binaries need more
      if (process.env.OXWASM_STRACE) eng.strace = [];     // debugging: keep a ring of syscalls, shown when the guest exits unexpectedly
      if (process.env.OXWASM_STRACE) eng.strace = [];     // debugging: syscall ring, printed on tgkill/kill when OXWASM_STRACE_SIGNAL is set
      if (image.meta) {                             // a rootfs carries symlinks, empty directories and file modes
        const m = eng._fsMeta();
        for (const [k, v] of image.meta.links) m.links.set(k, v);
        for (const d of image.meta.dirs) m.dirs.add(d);
        m.modes = new Map(image.meta.modes);
        m.v++;
      }
      eng.mem.cpuV2 = packages.length > 0 || !!o.cpuV2;              // compiled extension packages (numpy) are built for x86-64-v2
      eng.pumpAsm = () => asm.pump();
      // Compiled code runs as a wasm-to-wasm chain that only re-checks the
      // clock when its fuel runs out; bottomless fuel means one run() can hold
      // the thread indefinitely. The packed browser page sets the same pair.
      if (process.env.OXWASM_NOAOT) { eng.aotCallThreshold = 1e15; eng.aotLoopThreshold = 1e15; }
      if (process.env.OXWASM_AOTCALL) { eng.aotCallThreshold = +process.env.OXWASM_AOTCALL; eng.aotLoopThreshold = +process.env.OXWASM_AOTLOOP; }
      if (process.env.OXWASM_FRAMETRACE) globalThis.__frameTrace = true;
      eng.chainFuel = 2048; eng.loopYield = 20000;
      return eng;
    };

    const key = cacheKey({ python, packages, commands, memMB, cpuV2: o.cpuV2, cpus: o.cpus, network: netp ? [netp.resolvers, caBundle && sha(readFileSync(caBundle))] : null, rootfs: o.rootfs }, guestSrc);
    // A snapshot taken by the caller (Sandbox#snapshot) restores instead of the shared boot cache.
    const userSnap = o.restoreFrom ? String(o.restoreFrom) : null;
    let userMeta = null;
    if (userSnap) {
      try { userMeta = JSON.parse(readFileSync(join(userSnap, 'fsmeta.json'), 'utf8')); }
      catch (e) { throw new Error(`sandbox: ${userSnap} is not a sandbox snapshot (${e.message})`); }
      if (userMeta.key !== key) throw new Error('sandbox: this snapshot was taken on a different image, options or oxwasm version; recreate the sandbox with the same options and the same oxwasm');
    }
    const snap = userSnap ? join(userSnap, 'snap') : join(CACHE_DIR, 'snapshots', key, 'snap');
    host.snapPath = snap;
    host.key = key; host.memMB = memMB;
    host._baseRefs = new Map(Object.entries(image.files));   // what the filesystem looked like before the guest touched it
    host._asm = asm;

    // Compiled units, entry -> wasm bytes. Captured while a snapshot is being
    // prepared and served back on restore through the engine's own manifest
    // hook (the one the packed browser page starts hot with): a snapshot drops
    // the compiled tier, and without this every unit is translated again from
    // scratch - the JS-side analysis and emit, not wat2wasm, was the cost.
    const units = new Map();
    const unitsFile = userSnap ? join(userSnap, 'units.bin') : join(CACHE_DIR, 'snapshots', key, 'units.bin');
    host._units = units;

    // Several sandboxes started together on a cold cache would each spend a full
    // cold boot building the same snapshot. One builds it under a lock; the
    // others wait for it to appear and restore from it. A lock whose owner died
    // is taken over once it is stale.
    const lockDir = join(CACHE_DIR, 'snapshots', key + '.lock');
    let haveLock = false;
    if (!userSnap && useCache && !existsSync(snap + '.mem')) {
      mkdirSync(join(CACHE_DIR, 'snapshots'), { recursive: true });
      const giveUp = Date.now() + (o.bootTimeoutMs || 300000);
      while (!existsSync(snap + '.mem')) {
        try { mkdirSync(lockDir); haveLock = true; break; } catch {}
        try { if (Date.now() - statSync(lockDir).mtimeMs > 600000) rmSync(lockDir, { recursive: true, force: true }); } catch {}
        if (Date.now() > giveUp) break;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const unlock = () => { if (haveLock) { haveLock = false; try { rmSync(lockDir, { recursive: true, force: true }); } catch {} } };

    let restored = false;
    host.eng = make();
    host.eng.onUnitBytes = (k, b) => { if (!units.has(k)) units.set(k, new Uint8Array(b)); };
    if ((userSnap || useCache) && existsSync(snap + '.mem')) {
      try {
        restoreEngine(host.eng, null, snap, CPU);
        if (userMeta) host._applyFsMeta(userMeta);
        host.pipe = host.eng.fds.get(0).pipe;
        if (process.env.OXWASM_DEBUG_RESTORE) console.error('[restore] stdin weof=' + host.pipe.weof, 'size=' + host.pipe.size, 'threads=' + JSON.stringify(host.eng.threads.map((t) => [t.id, t.state])), 'blocked=' + JSON.stringify(host.eng.blocked && { dl: host.eng.blocked.deadline }), 'exitCode=' + host.eng.exitCode);
        restored = true;
        host.unitsLoaded = loadUnits(unitsFile, host.eng);
      } catch (e) {
        if (userSnap) throw new Error(`sandbox: could not restore ${userSnap}: ${e.message}`);
        o.log?.(`snapshot unusable (${e.message}); cold boot`);
        try { rmSync(join(CACHE_DIR, 'snapshots', key), { recursive: true, force: true }); } catch {}
        host.eng = make();
      }
    }
    if (!restored) {
      // stdin is a pipe the host owns: the engine's pipes already block a
      // reader on an empty buffer, which is what keeps the driver alive and
      // waiting between requests (the default stdin is a fixed array that
      // reads EOF, and CPython would exit on it).
      host.pipe = { chunks: [], pos: 0, off: 0, size: 0 };
      host.eng.fds.set(0, { pipe: host.pipe, mode: 'r' });
    }

    const tBoot = performance.now();
    // A cold guest announces itself. A restored one already did, before the
    // snapshot was taken, so it is asked instead: a round trip proves the
    // restored process is alive and reading its stdin.
    let hello;
    try {
      hello = restored ? await host._ping(30000) : await host._untilReady(o.bootTimeoutMs || 300000);
    } catch (e) { unlock(); throw e; }
    if (!restored && useCache && !userSnap) {
      try { await host._warm(); } catch (e) { o.log?.(`warm-up failed: ${e.message}`); }
      try {
        const dir = join(CACHE_DIR, 'snapshots', key);
        const tmp = dir + '.tmp' + process.pid + '_' + Math.random().toString(36).slice(2);
        mkdirSync(tmp, { recursive: true });
        await snapshotEngine(host.eng, null, join(tmp, 'snap'));
        saveUnits(join(tmp, 'units.bin'), units);
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
        renameSync(tmp, dir);
      } catch (e) { o.log?.(`could not save snapshot: ${e.message}`); }
    }
    unlock();
    host.bootInfo = { restored, imageMs: tImage, bootMs: performance.now() - tBoot, totalMs: performance.now() - t0,
                      python: hello.python, image: image.stats, key, units: host.unitsLoaded || units.size };
    return host;
  }

  // ---- protocol -----------------------------------------------------------
  send(body) {
    const json = new TextEncoder().encode(JSON.stringify(body));
    for (const b of [new TextEncoder().encode(`${json.length}\n`), json]) {
      this.pipe.chunks.push(b); this.pipe.size = (this.pipe.size ?? 0) + b.length;
    }
    this.eng.wakeAllBlk();
  }

  sigint() { this.eng.raiseSignal(2, null, { pid: 0, code: 0 }); }

  _ingest() {
    const eng = this.eng, chunks = eng.stdoutBytes;
    if (!chunks.length) return;
    this.buf = Buffer.concat([this.buf, ...chunks.map((c) => Buffer.from(c))]);
    chunks.length = 0; eng.stdout.length = 0;      // consumed: do not let a long session grow these forever
    for (;;) {
      const i = this.buf.indexOf(1);
      if (i < 0) { this.buf = Buffer.alloc(0); return; }
      const nl = this.buf.indexOf(10, i);
      if (nl < 0) return;
      const n = +this.buf.subarray(i + 1, nl).toString();
      if (!Number.isFinite(n) || this.buf.length < nl + 1 + n) return;
      const json = this.buf.subarray(nl + 1, nl + 1 + n).toString('utf8');
      this.buf = this.buf.subarray(nl + 1 + n);
      this.onFrame(JSON.parse(json));
    }
  }

  /** One bounded slice. Returns { exit } or { waitMs } - how long to sleep before waking the guest. */
  step() {
    const eng = this.eng;
    eng.netPump?.();
    eng.sliceDeadline = performance.now() + SLICE_MS;
    eng.run(5e7);
    eng.netPump?.();
    eng.sliceDeadline = null;
    this._ingest();
    if (eng.exitCode !== null) return { exit: eng.exitCode };
    if (eng.blocked) {
      const dl = eng.blocked.deadline;
      return { waitMs: dl != null && isFinite(dl) ? Math.max(0, Math.min(20, dl - eng.nowMs())) : 1, blocked: true };
    }
    return { waitMs: 0 };
  }

  async _untilReady(timeoutMs) {
    let ready = null;
    const prev = this.onFrame;
    this.onFrame = (f) => { if (f.ev === 'ready') ready = f; else prev(f); };
    const t0 = Date.now();
    while (!ready) {
      const r = this.step();
      if (r.exit !== undefined) throw new Error(`sandbox: the guest exited during boot (${r.exit}): ${this._stderr()}`);
      if (Date.now() - t0 > timeoutMs) throw new Error(`sandbox: guest not ready within ${timeoutMs} ms`);
      if (r.blocked) { await new Promise((res) => setTimeout(res, r.waitMs)); this.eng.wake(); }
      else await new Promise((res) => setImmediate(res));
    }
    this.onFrame = prev;
    return ready;
  }

  /** Send one request and drive the guest until its closing frame. Other frames are ignored. */
  async _roundTrip(body, timeoutMs) {
    let end = null;
    const prev = this.onFrame;
    this.onFrame = (f) => { if (f.id === body.id && (f.ev === 'done' || f.ev === 'error')) end = f; else if (f.id !== body.id) prev(f); };
    this.send(body);
    const t0 = Date.now();
    while (!end) {
      const r = this.step();
      if (r.exit !== undefined) throw new Error(`sandbox: the guest exited (${r.exit}): ${this._stderr()}${this.eng.strace ? '\n  last syscalls: ' + this.eng.strace.slice(-25).join(' ') : ''}`);
      if (Date.now() - t0 > timeoutMs) throw new Error(`sandbox: '${body.op}' did not answer within ${timeoutMs} ms`);
      if (r.blocked) { await new Promise((res) => setTimeout(res, r.waitMs)); this.eng.wake(); }
      else await new Promise((res) => setImmediate(res));
    }
    this.onFrame = prev;
    return end;
  }

  async _ping(timeoutMs) { await this._roundTrip({ op: 'ping', id: -1 }, timeoutMs); return {}; }

  /**
   * Run a representative first workload before the snapshot is taken. Two
   * things follow: the assembled-unit cache is filled with exactly the code a
   * first cell reaches, and the modules it imports are already loaded in the
   * process every later sandbox is restored from. It runs in a throwaway
   * context and cleans up after itself, so no user-visible state is left.
   */
  async _warm() {
    const cell = `
import json, re, os, sys, math, itertools, collections, subprocess
d = {str(i): [i, i * 2, {"k": i}] for i in range(200)}
s = json.dumps(d); assert json.loads(s) == d
words = re.findall(r"\\w+", "the quick brown fox " * 50)
c = collections.Counter(words)
sorted(c.items()); sum(math.sqrt(i) for i in range(2000)); list(itertools.permutations(range(6)))
open("/tmp/_oxw", "w").write("x" * 4096); os.remove("/tmp/_oxw")
subprocess.run(["/bin/sh", "-c", "echo warm; ls / > /dev/null; cat /etc/passwd | wc -l"], capture_output=True)
print("ok")
`;
    let id = -100;
    const ctx = await this._roundTrip({ op: 'ctx_create', id: id-- }, 60000);
    await this._roundTrip({ op: 'run', id: id--, ctx: ctx.value.id, code: cell }, 240000);
    await this._roundTrip({ op: 'ctx_remove', id: id--, ctx: ctx.value.id }, 60000);
  }

  _stderr() { return (this.eng.stderr || []).join('').trim().split('\n').slice(-6).join(' | ').slice(0, 500); }

  /** What this sandbox is using right now, from the engine's own books. */
  metrics() {
    const eng = this.eng;
    let diskBytes = 0, procs = 0;
    for (const p of eng.dirtyFiles) diskBytes += eng.files[p]?.length ?? 0;
    const countProcs = (e, seen = new Set()) => { if (seen.has(e)) return 0; seen.add(e); let n = 1; for (const c of e.children ?? []) if (c.eng && c.exited === null && c.eng.exitCode === null) n += countProcs(c.eng, seen); return n; };
    procs = countProcs(eng);
    const brkUsed = Number(eng.brk - eng._brk0), mmapUsed = Number(eng.mmapNext - eng._mmapBase);
    return { diskUsedBytes: diskBytes, diskLimitBytes: eng._diskQuota || null,
             guestMemUsedBytes: brkUsed + mmapUsed, guestMemLimitBytes: this.memMB * 1048576,
             processes: procs, filesWritten: eng.dirtyFiles.size };
  }

  /** Put back the parts of the filesystem a snapshot's engine blob does not carry. */
  _applyFsMeta(meta) {
    const eng = this.eng, m = eng._fsMeta();
    for (const p of meta.deleted) delete eng.files[p];
    m.links = new Map(meta.links); m.dirs = new Set(meta.dirs); m.modes = new Map(meta.modes);
    m.v++;
  }

  /**
   * Write everything needed to bring this sandbox back in another process: guest memory, the
   * process's descriptors, every file the guest created, changed or deleted, symlinks, directories
   * and modes. Only valid while the guest is idle with no background processes.
   */
  async snapshotTo(dir) {
    const eng = this.eng, m = eng._fsMeta();
    mkdirSync(dir, { recursive: true });
    // the engine blob carries the dirty set; widen it to everything that differs from the image
    // (created, renamed, replaced) and remember what was deleted
    const dirty = eng.dirtyFiles, added = [];
    for (const p of Object.keys(eng.files)) if (eng.files[p] !== this._baseRefs.get(p) && !dirty.has(p)) { dirty.add(p); added.push(p); }
    const deleted = []; for (const p of this._baseRefs.keys()) if (eng.files[p] === undefined) deleted.push(p);
    try { await snapshotEngine(eng, null, join(dir, 'snap')); }
    finally { for (const p of added) dirty.delete(p); }
    saveUnits(join(dir, 'units.bin'), this._units);
    writeFileSync(join(dir, 'fsmeta.json'), JSON.stringify({ key: this.key, deleted, links: [...m.links], dirs: [...m.dirs], modes: [...(m.modes ?? [])], at: Date.now() }));
    return dir;
  }

  close() {
    try { this.pipe.weof = true; this.eng.wakeAllBlk(); this.eng.run(1e6); } catch {}
    try { this._asm?.close?.(); } catch {}
    this.eng = null;
  }
}

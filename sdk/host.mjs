// Owns one guest CPython: boots it (from a snapshot when there is one), frames
// the request/response protocol over its stdin/stdout, and steps the engine in
// bounded slices so whoever drives it stays responsive.
//
// This runs inside a worker thread (see worker.mjs), which is what makes the
// rest of the SDK safe to put in front of untrusted code: a guest that spins
// in compiled code never returns from a slice, and only a separate thread can
// be abandoned when that happens.
import { makeNet } from './net.mjs';
import { readFileSync, statSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { LinuxEngine } from '../engine/linux.mjs';
import { CPU } from '../engine/interp.mjs';
import { snapshotEngine, restoreEngine } from '../engine/snapshot.mjs';
import { makeAssembler } from '../tools/assemble.mjs';
import { buildImage, findPythonTree, CACHE_DIR, DEFAULT_COMMANDS } from './image.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const GUEST_PATH = '/oxwasm/guest.py';
export const SLICE_MS = 40;                       // how long the guest may hold the thread at a stretch

const sha = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest('hex').slice(0, 20); };

// A snapshot is only valid for the exact machine it was taken on: the same
// interpreter, the same mounted packages, the same tools, the same driver and
// the same engine. Anything else must miss.
function cacheKey({ python, packages, commands, memMB, network }, guestSrc) {
  const engine = [...['linux.mjs', 'aot_wat.mjs', 'interp.mjs', 'decode.mjs', 'snapshot.mjs', 'snapshot_core.mjs']
    .map((f) => sha(readFileSync(join(HERE, '..', 'engine', f)))),
    // the SDK's own code decides what goes into a snapshot (the warm-up, the unit capture)
    ...['host.mjs', 'image.mjs', 'net.mjs'].map((f) => sha(readFileSync(join(HERE, f))))];
  const stamp = (p) => { try { const s = readFileSync(p).length; return `${p}:${s}`; } catch { return p; } };
  return sha(JSON.stringify({ python: stamp(python), tree: findPythonTree(python), memMB,
                              packages: [...packages].sort(), commands: [...commands].sort(), network, engine }), guestSrc);
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
    const image = buildImage({ python, packages, commands, extraFiles: { [GUEST_PATH]: new Uint8Array(guestSrc) },
                               network: netp ? { resolvers: netp.resolvers } : null });
    const tImage = performance.now() - t0;

    let asm = null;
    try { asm = makeAssembler({ tag: 'oxsb' }); }
    catch (e) { throw new Error(`sandbox: ${e.message}`); }

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

    const make = () => {
      const eng = new LinuxEngine(image.files[python], {
        argv: [python, '-S', '-B', GUEST_PATH],
        env: ['PATH=/usr/bin:/bin', 'HOME=/root', 'LANG=C.UTF-8', 'PYTHONDONTWRITEBYTECODE=1', 'PYTHONUNBUFFERED=1',
              ...(packages.length ? [`PYTHONPATH=${packages.join(':')}`] : []),
              // glibc would otherwise pick its SSSE3/SSE4.2 string routines on a v2 CPU
              ...(netp ? ['SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt', 'REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt', 'CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt'] : []),
              ...(packages.length ? ['GLIBC_TUNABLES=glibc.cpu.hwcaps=-SSSE3,-SSE4_1,-SSE4_2,-POPCNT'] : []), ...(o.env || [])],
        files: image.files, mtimes: image.mtimes, memMB, assembleWat, net: netp,
      });
      eng.assembleWatDeferred = assembleWatDeferred;
      eng.mem.cpuV2 = packages.length > 0;              // compiled extension packages (numpy) are built for x86-64-v2
      eng.pumpAsm = () => asm.pump();
      // Compiled code runs as a wasm-to-wasm chain that only re-checks the
      // clock when its fuel runs out; bottomless fuel means one run() can hold
      // the thread indefinitely. The packed browser page sets the same pair.
      if (process.env.OXWASM_NOAOT) { eng.aotCallThreshold = 1e15; eng.aotLoopThreshold = 1e15; }
      eng.chainFuel = 2048; eng.loopYield = 20000;
      return eng;
    };

    const key = cacheKey({ python, packages, commands, memMB, network: netp ? netp.resolvers : null }, guestSrc);
    const snap = join(CACHE_DIR, 'snapshots', key, 'snap');
    host.snapPath = snap;
    host._asm = asm;

    // Compiled units, entry -> wasm bytes. Captured while a snapshot is being
    // prepared and served back on restore through the engine's own manifest
    // hook (the one the packed browser page starts hot with): a snapshot drops
    // the compiled tier, and without this every unit is translated again from
    // scratch - the JS-side analysis and emit, not wat2wasm, was the cost.
    const units = new Map();
    const unitsFile = join(CACHE_DIR, 'snapshots', key, 'units.bin');

    // Several sandboxes started together on a cold cache would each spend a full
    // cold boot building the same snapshot. One builds it under a lock; the
    // others wait for it to appear and restore from it. A lock whose owner died
    // is taken over once it is stale.
    const lockDir = join(CACHE_DIR, 'snapshots', key + '.lock');
    let haveLock = false;
    if (useCache && !existsSync(snap + '.mem')) {
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
    if (useCache && existsSync(snap + '.mem')) {
      try {
        restoreEngine(host.eng, null, snap, CPU);
        host.pipe = host.eng.fds.get(0).pipe;
        restored = true;
        host.unitsLoaded = loadUnits(unitsFile, host.eng);
      } catch (e) {
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
    if (!restored && useCache) {
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
      if (r.exit !== undefined) throw new Error(`sandbox: the guest exited (${r.exit}): ${this._stderr()}`);
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

  close() {
    try { this.pipe.weof = true; this.eng.wakeAllBlk(); this.eng.run(1e6); } catch {}
    try { this._asm?.close?.(); } catch {}
    this.eng = null;
  }
}

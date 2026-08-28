// Engine snapshot/restore: capture a settled LinuxEngine (+XServer) so a
// later process can resume instantly instead of re-running startup.
//
// What is saved: the whole guest wasm memory (gzipped in chunks), every
// thread's CPU context, the fd table (regular files by path+pos, pipes with
// their buffered chunks, eventfds, X connections by index), dirty guest file
// contents, engine layout scalars (brk/mmap cursor/maps/execRanges), and the
// X server's resource tree (windows/pixmaps/GCs with their pixel buffers),
// connections, atoms and framebuffer.
//
// What is deliberately dropped: tier state (profile counters, compiled units,
// decode caches). Execution re-heats after restore; with a warm wat2wasm
// content cache the recompiles are cheap. Deadlines are rebased to the new
// process's clock.
import { writeFileSync, readFileSync, createWriteStream, createReadStream } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';

const CHUNK = 256 << 20;                                    // gzip in 256MB slices

const j = (v) => JSON.stringify(v, (_, x) =>
  typeof x === 'bigint' ? '≠' + x.toString(16) : x);
const uj = (s) => JSON.parse(s, (_, x) =>
  typeof x === 'string' && x.startsWith('≠') ? BigInt('0x' + x.slice(1)) : x);

class BlobWriter {
  constructor() { this.parts = []; this.off = 0; }
  add(u8) { if (!u8 || u8.length === 0) return { o: this.off, n: 0 };
    const b = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
    this.parts.push(b); const r = { o: this.off, n: b.length }; this.off += b.length; return r; }
  bytes() { return Buffer.concat(this.parts); }
}

const cpuState = (cpu) => ({ regs: cpu.regs.slice(), xmm: cpu.xmm.slice(),
  rip: cpu.rip, fsBase: cpu.fsBase ?? 0n, f: { ...cpu.f } });
const loadCpu = (cpu, st) => { cpu.regs = st.regs.map(BigInt); cpu.xmm = st.xmm.map(BigInt);
  cpu.rip = BigInt(st.rip); cpu.fsBase = BigInt(st.fsBase); cpu.f = { ...st.f }; cpu.icache?.clear(); };

export function snapshotEngine(eng, xs, path) {
  const bw = new BlobWriter();
  const now = eng.nowMs();

  // ---- fd table -------------------------------------------------------------
  const pipes = new Map();                                  // pipe obj -> index
  const conns = xs ? xs.conns : [];
  const fds = [];
  for (const [fd, h] of eng.fds) {
    if (h.sink) { fds.push([fd, { sink: h.sink }]); continue; }
    if (h.isdir) { fds.push([fd, { isdir: true, path: h.path, pos: h.pos }]); continue; }
    if (h.ev) { fds.push([fd, { ev: { count: h.ev.count, nonblock: h.ev.nonblock, sem: h.ev.sem } }]); continue; }
    if (h.pipe) {
      if (!pipes.has(h.pipe)) pipes.set(h.pipe, pipes.size);
      fds.push([fd, { pipe: pipes.get(h.pipe), mode: h.mode }]); continue;
    }
    if (h.sock) { fds.push([fd, { sock: true, conn: h.sock.conn ? conns.indexOf(h.sock.conn) : -1,
                                  nonblock: !!h.sock.nonblock }]); continue;
    }
    if (h.bytes !== undefined) { fds.push([fd, { file: h.path, pos: h.pos, writable: !!h.writable }]); continue; }
    fds.push([fd, { unknown: true }]);
  }
  const pipeBufs = [...pipes.keys()].map(p => p.chunks.map(c => bw.add(c)));

  // ---- dirty guest files ----------------------------------------------------
  const dirty = [];
  for (const p of eng.dirtyFiles ?? []) {
    const f = eng.files[p];
    if (f) dirty.push([p, bw.add(f)]);
  }

  // ---- X server -------------------------------------------------------------
  let x = null;
  if (xs) {
    const fontIdx = (f) => { if (!f) return -1;
      for (let i = 0; i < xs.fonts.length; i++) if (xs.fonts[i].font === f) return i;
      return xs.defaultFont === f ? -2 : -1; };
    const resl = [];
    for (const [id, r] of xs.res) {
      const e = { id };
      for (const [k, v] of Object.entries(r)) {
        if (k === 'conn') e.conn = conns.indexOf(v);
        else if (k === 'parent') e.parent = v ? v.id : null;
        else if (k === 'children') e.children = v.map(c => c.id);
        else if (k === 'buffer') e.buffer = v ? bw.add(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) : null;
        else if (k === 'props') e.props = [...v.entries()].map(([pk, pv]) =>
          [pk, pv instanceof Uint8Array ? { blob: bw.add(pv) } :
               ArrayBuffer.isView(pv) ? { blob: bw.add(new Uint8Array(pv.buffer, pv.byteOffset, pv.byteLength)), ta: pv.constructor.name } : pv]);
        else if (k === 'font' || k === 'fontObj') e[k + 'Idx'] = fontIdx(v);
        else if (typeof v !== 'function' && typeof v !== 'object' || v === null) e[k] = v;
        else if (Array.isArray(v) && v.every(z => typeof z !== 'object')) e[k] = v;
        else if (v instanceof Uint32Array || v instanceof Uint8Array)
          e[k] = { blob: bw.add(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)), ta: v.constructor.name };
        else e[k] = j(v);                                   // small plain object -> embedded json
      }
      resl.push(e);
    }
    x = { res: resl, atoms: xs.atoms, rootId: xs.rootId,
          ptr: { ...xs.ptr }, focus: xs.focus,
          grabWindow: xs.grabWindow ? xs.grabWindow.id : null,
          fb: bw.add(new Uint8Array(xs.fb.buffer, xs.fb.byteOffset, xs.fb.byteLength)),
          timeBase: xs.timeBase,
          conns: conns.map(c => ({ seq: c.seq, setupDone: c.setupDone, ridBase: c.ridBase,
            inbuf: bw.add(c.inbuf), outOff: c.outOff, out: c.out.map(o => bw.add(o)) })) };
  }

  const state = {
    v: 1, now,
    base: eng.base, brk: eng.brk, mmapNext: eng.mmapNext, stackTop: eng.stackTop,
    execRanges: eng.execRanges, maps: eng.maps ?? [],
    ti: eng.ti, nextTid: eng.nextTid,
    blocked: eng.blocked, _deadline: eng._deadline,
    _futexAddr: eng._futexAddr ?? null,
    stats: { interpreted: eng.stats.interpreted, aotRuns: eng.stats.aotRuns },
    threads: eng.threads.map(t => ({ id: t.id, state: t.state, dl: t.dl, _dl: t._dl,
      futex: t.futex, ctid: t.ctid, cpu: cpuState(t.cpu) })),
    fds, pipeBufs, dirty, x,
    memLen: eng.wmem.buffer.byteLength,
  };
  writeFileSync(path + '.json', j(state));
  writeFileSync(path + '.blobs', bw.bytes());
  // memory: sparse 1MB tiles — all-zero tiles are skipped entirely, so restore
  // into fresh (zero) wasm memory only touches pages that held data.
  const TILE = 1 << 20;
  const ws = createWriteStream(path + '.mem');
  ws.write(Buffer.from('SPRS'));
  const all = new Uint8Array(eng.wmem.buffer);
  const words = new BigUint64Array(eng.wmem.buffer);
  const wordsPerTile = TILE / 8;
  for (let o = 0; o < all.length; o += TILE) {
    const w0 = o / 8, w1 = Math.min(w0 + wordsPerTile, words.length);
    let nz = false;
    for (let w = w0; w < w1; w++) if (words[w] !== 0n) { nz = true; break; }
    if (!nz) continue;
    const len = Math.min(TILE, all.length - o);
    const gz = gzipSync(Buffer.from(all.buffer, o, len), { level: 1 });
    const hdr = Buffer.alloc(16);
    hdr.writeUIntLE(o, 0, 6); hdr.writeUInt32LE(len, 6); hdr.writeUInt32LE(gz.length, 10);
    ws.write(hdr); ws.write(gz);
  }
  return new Promise(res => ws.end(() => res({ blobs: bw.off })));
}

export function restoreEngine(eng, xs, path, CPUctor) {
  const state = uj(readFileSync(path + '.json', 'utf8'));
  const blobs = readFileSync(path + '.blobs');
  const blob = (r) => r ? blobs.subarray(r.o, r.o + r.n) : new Uint8Array(0);

  // ---- memory ---------------------------------------------------------------
  if (eng.wmem.buffer.byteLength !== Number(state.memLen))
    throw new Error(`snapshot memMB mismatch: have ${eng.wmem.buffer.byteLength}, snap ${state.memLen}`);
  {
    const all = new Uint8Array(eng.wmem.buffer);
    const f = readFileSync(path + '.mem');
    if (f.subarray(0, 4).toString() === 'SPRS') {           // sparse tile format
      let fo = 4;
      while (fo < f.length) {
        const o = f.readUIntLE(fo, 6), rawLen = f.readUInt32LE(fo + 6), gzLen = f.readUInt32LE(fo + 10); fo += 16;
        all.set(gunzipSync(f.subarray(fo, fo + gzLen)), o); fo += gzLen;
      }
    } else {                                                // legacy contiguous chunks
      let fo = 0, mo = 0;
      while (fo < f.length) {
        const gzLen = f.readUInt32LE(fo), rawLen = f.readUInt32LE(fo + 4); fo += 8;
        const raw = gunzipSync(f.subarray(fo, fo + gzLen)); fo += gzLen;
        all.set(raw, mo); mo += rawLen;
      }
    }
  }

  // ---- engine scalars / threads --------------------------------------------
  const dnow = eng.nowMs() - Number(state.now);
  const rebase = (d) => d == null ? null : Number(d) + dnow;
  eng.base = state.base; eng.brk = state.brk; eng.mmapNext = state.mmapNext; eng.stackTop = state.stackTop;
  eng.execRanges = state.execRanges.map(([a, b]) => [BigInt(a), BigInt(b)]);
  eng.maps = state.maps;
  eng.nextTid = state.nextTid;
  eng.blocked = state.blocked ? { deadline: rebase(state.blocked.deadline) } : null;
  eng._deadline = rebase(state._deadline);
  eng._futexAddr = state._futexAddr;
  eng.threads = state.threads.map((t, i) => {
    const cpu = i === 0 ? eng.cpu : new CPUctor(eng.mem);
    if (i !== 0) cpu.onSyscall = (c) => eng.syscall(c);
    loadCpu(cpu, t.cpu);
    return { id: t.id, state: t.state, dl: rebase(t.dl), _dl: rebase(t._dl),
             futex: t.futex, ctid: t.ctid, cpu };
  });
  eng.ti = state.ti;
  eng.cpu = eng.threads[eng.ti].cpu;

  // ---- dirty files ----------------------------------------------------------
  for (const [p, r] of state.dirty) {
    eng.files[p] = new Uint8Array(blob(r));
    (eng.dirtyFiles ??= new Set()).add(p);
  }

  // ---- X server -------------------------------------------------------------
  let conns = [];
  if (xs && state.x) {
    const sx = state.x;
    xs.atoms = sx.atoms; xs.rootId = sx.rootId; xs.ptr = { ...sx.ptr }; xs.focus = sx.focus;
    xs.timeBase = sx.timeBase - dnow;                       // xs.now() stays continuous
    new Uint8Array(xs.fb.buffer, xs.fb.byteOffset, xs.fb.byteLength).set(blob(sx.fb));
    conns = sx.conns.map(() => xs.connect());
    xs.conns = conns;
    for (let i = 0; i < conns.length; i++) {
      const c = conns[i], sc = sx.conns[i];
      c.seq = sc.seq; c.setupDone = sc.setupDone; c.ridBase = sc.ridBase;
      c.inbuf = new Uint8Array(blob(sc.inbuf)); c.outOff = sc.outOff;
      c.out = sc.out.map(r => new Uint8Array(blob(r)));
    }
    xs.res = new Map();
    const byId = new Map();
    for (const e of sx.res) {
      const r = {};
      for (const [k, v] of Object.entries(e)) {
        if (k === 'id') r.id = v;
        else if (k === 'conn') r.conn = v >= 0 ? conns[v] : null;
        else if (k === 'parent' || k === 'children') continue;        // second pass
        else if (k === 'buffer') r.buffer = v ? new Uint32Array(new Uint8Array(blob(v)).slice().buffer) : null;
        else if (k === 'props') r.props = new Map(v.map(([pk, pv]) =>
          [pk, pv && pv.blob !== undefined ? new Uint8Array(blob(pv)).slice() : pv]));
        else if (k === 'fontIdx') r.font = v === -2 ? xs.defaultFont : v >= 0 ? xs.fonts[v].font : null;
        else if (k === 'fontObjIdx') r.fontObj = v === -2 ? xs.defaultFont : v >= 0 ? xs.fonts[v].font : null;
        else if (v && v.blob !== undefined) {
          const raw = new Uint8Array(blob(v)).slice();
          r[k] = v.ta === 'Uint32Array' ? new Uint32Array(raw.buffer) : raw;
        }
        else if (typeof v === 'string' && (v.startsWith('{') || v.startsWith('['))) { try { r[k] = uj(v); } catch { r[k] = v; } }
        else r[k] = v;
      }
      xs.res.set(r.id, r); byId.set(r.id, r);
    }
    for (const e of sx.res) {
      const r = byId.get(e.id);
      if (e.parent !== undefined) r.parent = e.parent != null ? byId.get(e.parent) ?? null : null;
      if (e.children) r.children = e.children.map(id => byId.get(id)).filter(Boolean);
    }
    xs.root = byId.get(xs.rootId);
    xs.grabWindow = sx.grabWindow != null ? byId.get(sx.grabWindow) ?? null : null;
  }

  // ---- fd table -------------------------------------------------------------
  const pipeObjs = state.pipeBufs.map(bufs => ({ chunks: bufs.map(r => new Uint8Array(blob(r)).slice()) }));
  eng.fds = new Map();
  for (const [fd, h] of state.fds) {
    if (h.sink) { eng.fds.set(fd, { sink: h.sink }); continue; }
    if (h.isdir) { eng.fds.set(fd, { isdir: true, path: h.path, pos: h.pos }); continue; }
    if (h.ev) { eng.fds.set(fd, { ev: { count: BigInt(h.ev.count), nonblock: h.ev.nonblock, sem: h.ev.sem } }); continue; }
    if (h.pipe !== undefined) { eng.fds.set(fd, { pipe: pipeObjs[h.pipe], mode: h.mode }); continue; }
    if (h.sock) { eng.fds.set(fd, { sock: { conn: h.conn >= 0 ? conns[h.conn] : null, nonblock: h.nonblock } }); continue; }
    if (h.file !== undefined) {
      const f = eng.files[h.file];
      eng.fds.set(fd, { bytes: f ?? new Uint8Array(0), pos: h.pos, path: h.file, writable: h.writable });
      continue;
    }
  }
  eng.stats.interpreted = state.stats.interpreted;
  eng.stats.aotRuns = state.stats.aotRuns ?? 0;
  return state;
}

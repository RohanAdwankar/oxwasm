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
import { restoreEngineCore } from './snapshot_core.mjs';

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
      fds.push([fd, { pipe: pipes.get(h.pipe), mode: h.mode, nonblock: !!h.nonblock }]); continue;
    }
    if (h.sock) { fds.push([fd, { sock: true, conn: h.sock.conn ? conns.indexOf(h.sock.conn) : -1,
                                  nonblock: !!h.sock.nonblock }]); continue;
    }
    if (h.bytes !== undefined) { fds.push([fd, { file: h.path, pos: h.pos, writable: !!h.writable }]); continue; }
    fds.push([fd, { unknown: true }]);
  }
  const pipeBufs = [...pipes.keys()].map(p => p.chunks.map(c => bw.add(c)));
  // What the chunks alone do not say: how far into the first one a reader has
  // got, how many bytes are buffered, and whether the write side is closed. A
  // pipe restored without them reads NaN out of `chunks[0].length - off`, and a
  // guest that was blocked reading one (a long-lived process waiting on its
  // stdin) cannot be resumed.
  const pipeMeta = [...pipes.keys()].map(p => ({ off: p.off ?? 0, size: p.size ?? p.chunks.reduce((n, c) => n + c.length, 0),
                                                 weof: !!p.weof, wtot: p.wtot ?? 0, rtot: p.rtot ?? 0 }));

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
          grab: xs.grab ? { win: xs.grab.win.id, mask: xs.grab.mask,
                            ownerEvents: xs.grab.ownerEvents, implicit: xs.grab.implicit } : null,
          fb: bw.add(new Uint8Array(xs.fb.buffer, xs.fb.byteOffset, xs.fb.byteLength)),
          timeBase: xs.timeBase,
          conns: conns.map(c => ({ seq: c.seq, setupDone: c.setupDone, ridBase: c.ridBase,
            inbuf: bw.add(c.inbuf), outOff: c.outOff, out: c.out.map(o => bw.add(o)) })) };
  }

  const state = {
    v: 1, now,
    base: eng.base, brk: eng.brk, mmapNext: eng.mmapNext, _mmapBase: eng._mmapBase, stackTop: eng.stackTop,
    execRanges: eng.execRanges, execRangesStatic: eng.execRangesStatic ?? null,
    // maps WITHOUT their file handle. `h` is the open-file object and it holds
    // the whole file's bytes, which JSON.stringify turns into an index-keyed
    // object: eight mappings of libc and libcrypto serialized to 382 MB
    // against 3.4 MB for the entire guest memory beside them. The bytes are
    // already in the memory image, and restore re-attaches a live handle by
    // path - which also fixes what came back before, a plain object whose
    // `bytes` was not a typed array at all.
    maps: (eng.maps ?? []).map(({ at, len, path, fileOff, shared }) => ({ at, len, path, fileOff, shared })),
    ti: eng.ti, nextTid: eng.nextTid,
    blocked: eng.blocked, _deadline: eng._deadline,
    _futexAddr: eng._futexAddr ?? null,
    stats: { interpreted: eng.stats.interpreted, aotRuns: eng.stats.aotRuns },
    threads: eng.threads.map(t => ({ id: t.id, state: t.state, dl: t.dl, _dl: t._dl,
      futex: t.futex, ctid: t.ctid, cpu: cpuState(t.cpu),
      sigmask: t.sigmask ?? 0n, pending: t.pending ?? 0n, altstack: t.altstack ?? null })),
    // Process-level state a guest sets up once, early, and never again. Without
    // it a restored process has default dispositions for every signal - a
    // Python whose SIGINT handler was installed at startup dies with status 130
    // on its first Ctrl-C - and loses FD_CLOEXEC on descriptors it marked.
    sigact: [...(eng.sigact ?? [])], sigign: [...(eng.sigign ?? [])],
    nocldwait: !!eng.nocldwait, cloexec: [...(eng.cloexec ?? [])],
    fds, pipeBufs, pipeMeta, dirty, x,
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

// Node wrapper: read the three files and restore synchronously.
export function restoreEngine(eng, xs, path, CPUctor) {
  return restoreEngineCore(eng, xs, {
    json: readFileSync(path + '.json', 'utf8'),
    blobs: readFileSync(path + '.blobs'),
    mem: readFileSync(path + '.mem'),
  }, CPUctor, (b) => gunzipSync(b));
}

export { restoreEngineCore } from './snapshot_core.mjs';

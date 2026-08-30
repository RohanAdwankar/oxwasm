// Browser-safe snapshot restore core: no node imports. The node-side save
// and file-reading wrappers live in snapshot.mjs.
const uj = (s) => JSON.parse(s, (_, x) =>
  typeof x === 'string' && x.startsWith('\u2260') ? BigInt('0x' + x.slice(1)) : x);
const loadCpu = (cpu, st) => { cpu.regs = st.regs.map(BigInt); cpu.xmm = st.xmm.map(BigInt);
  cpu.rip = BigInt(st.rip); cpu.fsBase = BigInt(st.fsBase); cpu.f = { ...st.f }; cpu.icache?.clear(); };
// zero the in-memory function-dispatch map count (FTMAP in aot_wat.mjs;
// literal here to stay import-free) and the engine's mirror of it
const resetFtmap = (eng) => {
  // Prefer the engine's rebuild: it re-registers everything already in
  // aotFns, so units applied before an async tile chain finishes don't get
  // locked out of the in-wasm dispatch map (zero-only left them in aotFns
  // but permanently unmapped — every in-wasm resolution missed).
  if (eng.rebuildFtmap) return eng.rebuildFtmap();
  new DataView(eng.wmem.buffer).setUint32(0x10000, 0, true);
  eng._ftCount = 0; if (eng._ftSeen) eng._ftSeen = new Set();
};

// Environment-independent restore. `assets.blobs`/`assets.mem` are byte
// buffers; `inflate(bytes) -> bytes | Promise<bytes>` supplies gunzip (node:
// gunzipSync; browser: DecompressionStream). Returns the parsed state, or a
// Promise of it when inflate is async.
export function restoreEngineCore(eng, xs, assets, CPUctor, inflate) {
  const state = uj(typeof assets.json === 'string' ? assets.json : new TextDecoder().decode(assets.json));
  const blobs = assets.blobs;
  const blob = (r) => r ? blobs.subarray(r.o, r.o + r.n) : new Uint8Array(0);
  const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

  // ---- memory ---------------------------------------------------------------
  if (eng.wmem.buffer.byteLength !== Number(state.memLen))
    throw new Error(`snapshot memMB mismatch: have ${eng.wmem.buffer.byteLength}, snap ${state.memLen}`);
  let pending = null;                                       // promise chain for async inflate
  // assets.mem === null: the caller streams memory tiles into eng.wmem itself
  // (sidecar loader); only the engine/X state is restored here.
  if (assets.mem) {
    const all = new Uint8Array(eng.wmem.buffer);
    const f = assets.mem, fv = dv(f);
    const isSparse = f[0] === 0x53 && f[1] === 0x50 && f[2] === 0x52 && f[3] === 0x53;   // 'SPRS'
    const tiles = [];
    if (isSparse) {
      let fo = 4;
      while (fo < f.length) {
        const o = fv.getUint32(fo, true) + fv.getUint16(fo + 4, true) * 0x100000000;
        const gzLen = fv.getUint32(fo + 10, true); fo += 16;
        tiles.push([o, f.subarray(fo, fo + gzLen)]); fo += gzLen;
      }
    } else {
      let fo = 0, mo = 0;
      while (fo < f.length) {
        const gzLen = fv.getUint32(fo, true), rawLen = fv.getUint32(fo + 4, true); fo += 8;
        tiles.push([mo, f.subarray(fo, fo + gzLen)]); fo += gzLen; mo += rawLen;
      }
    }
    const first = tiles.length ? inflate(tiles[0][1]) : null;
    if (first && typeof first.then === 'function') {
      pending = (async () => {
        all.set(await first, tiles[0][0]);
        for (let i = 1; i < tiles.length; i++) all.set(await inflate(tiles[i][1]), tiles[i][0]);
        resetFtmap(eng);
      })();
    } else {
      if (tiles.length) all.set(first, tiles[0][0]);
      for (let i = 1; i < tiles.length; i++) all.set(inflate(tiles[i][1]), tiles[i][0]);
    }
  }
  // The restored image may carry the CAPTURE engine's function-dispatch map
  // (scratch below RAMOFF): its funcref-table slots mean nothing here — a
  // stale hit would call_indirect into an empty table. Zero the count; this
  // engine's own registrations rebuild the map from scratch. (For the async
  // tile path this must run after the tiles land — see above.)
  resetFtmap(eng);

  // ---- engine scalars / threads --------------------------------------------
  const dnow = eng.nowMs() - Number(state.now);
  const rebase = (d) => d == null ? null : Number(d) + dnow;
  eng.base = state.base; eng.brk = state.brk; eng.mmapNext = state.mmapNext; eng.stackTop = state.stackTop;
  eng.execRanges = state.execRanges.map(([a, b]) => [BigInt(a), BigInt(b)]);
  eng.execRangesStatic = (state.execRangesStatic ?? state.execRanges).map(([a, b]) => [BigInt(a), BigInt(b)]);  // loop tiers stay on the pre-widening ground
  eng.maps = state.maps;
  // Older snapshots' execRanges cover only the main binary + ld.so (mmap
  // didn't extend them), which blinded profiling to every LIBRARY loop head,
  // jump landing, and deopt landing — the warm menu path stayed interpreted.
  // Rebuild coverage from the file-backed maps.
  for (const m of eng.maps ?? []) {
    const a = BigInt(m.at), b = BigInt(m.at) + BigInt(m.len);
    if (!eng.execRanges.some(([x, y]) => x <= a && b <= y)) eng.execRanges.push([a, b]);
  }
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
      if (e.parent !== undefined) r.parent = e.parent ?? null;   // live code stores the ID (win() resolves)
      if (e.children) r.children = e.children.map(id => byId.get(id)).filter(Boolean);
    }
    xs.root = byId.get(xs.rootId);
    for (const c of xs.root?.children ?? []) c.parent ??= xs.rootId;   // older snapshots saved null: QueryTree walked to window 0 forever

    xs.grabWindow = sx.grabWindow != null ? byId.get(sx.grabWindow) ?? null : null;
    xs.grab = sx.grab && byId.get(sx.grab.win)
      ? { win: byId.get(sx.grab.win), mask: sx.grab.mask,
          ownerEvents: sx.grab.ownerEvents, implicit: sx.grab.implicit } : null;
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
  return pending ? pending.then(() => state) : state;
}

// A minimal WebAssembly linker for oxwasm's own units: merge many modules into one.
//
// Every translated unit is a separate module with the same imports, and V8 keeps a dispatch table per
// instance for the shared funcref table: registering a function costs time proportional to the number of
// live instances (139 us per set at 4,000 instances), so loading thousands of units is quadratic. One
// module per few hundred units keeps the instance count in the dozens.
//
// The modules this emitter produces are simple (types, imports, functions, exports, code; no data,
// elem, globals or start), so linking is: unify types and imports, renumber functions, rewrite the
// indices inside code bodies, keep the first export of each name.

class R { // byte reader
  constructor(b, p = 0) { this.b = b; this.p = p; }
  u8() { return this.b[this.p++]; }
  uleb() { let r = 0, s = 0, x; do { x = this.b[this.p++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80); return r; }
  bytes(n) { const o = this.b.subarray(this.p, this.p + n); this.p += n; return o; }
  name() { const n = this.uleb(); return new TextDecoder().decode(this.bytes(n)); }
}
const enc = new TextEncoder();
function uleb(n) { const o = []; do { let x = n % 128; n = Math.floor(n / 128); if (n) x |= 0x80; o.push(x); } while (n); return o; }
function cat(parts) { let n = 0; for (const p of parts) n += p.length; const o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; }

export function parse(bytes) {
  const r = new R(bytes, 8);
  const m = { types: [], imports: [], funcs: [], exports: [], codes: [], tables: [], mems: [] };
  while (r.p < bytes.length) {
    const id = r.u8(), size = r.uleb(), end = r.p + size;
    if (id === 1) { const n = r.uleb(); for (let i = 0; i < n; i++) { const s = r.p; if (r.u8() !== 0x60) throw new Error('type form'); const np = r.uleb(); r.bytes(np); const nr = r.uleb(); r.bytes(nr); m.types.push(bytes.subarray(s, r.p)); } }
    else if (id === 2) { const n = r.uleb(); for (let i = 0; i < n; i++) { const mod = r.name(), nm = r.name(), kind = r.u8(); let desc;
      if (kind === 0) desc = r.uleb();
      else { const s = r.p; if (kind === 1) { r.u8(); const f = r.u8(); r.uleb(); if (f & 1) r.uleb(); } else if (kind === 2) { const f = r.u8(); r.uleb(); if (f & 1) r.uleb(); } else if (kind === 3) { r.u8(); r.u8(); } else throw new Error('import kind'); desc = bytes.subarray(s, r.p); }
      m.imports.push({ mod, name: nm, kind, desc }); } }
    else if (id === 3) { const n = r.uleb(); for (let i = 0; i < n; i++) m.funcs.push(r.uleb()); }
    else if (id === 7) { const n = r.uleb(); for (let i = 0; i < n; i++) m.exports.push({ name: r.name(), kind: r.u8(), idx: r.uleb() }); }
    else if (id === 10) { const n = r.uleb(); for (let i = 0; i < n; i++) { const sz = r.uleb(); m.codes.push(bytes.subarray(r.p, r.p + sz)); r.p += sz; } }
    else if (id === 0) { /* custom (names): dropped */ }
    else throw new Error('unsupported section ' + id);
    r.p = end;
  }
  return m;
}

// rewrite the function / type indices inside one function body
function rewriteBody(body, mapFn, mapType) {
  const r = new R(body), out = [];
  const copyFrom = (s) => { for (let i = s; i < r.p; i++) out.push(body[i]); };
  const nl = r.uleb(); { const s0 = 0; for (let i = 0; i < nl; i++) { r.uleb(); r.u8(); } copyFrom(s0); }
  const memarg = () => { r.uleb(); r.uleb(); };
  while (r.p < body.length) {
    const s = r.p, op = r.u8();
    if (op === 0x02 || op === 0x03 || op === 0x04) {
      const b = body[r.p];
      if (b === 0x40 || (b >= 0x6f && b <= 0x7f && b !== 0x6e)) { r.p++; copyFrom(s); }
      else { // s33 type index
        let v = 0, sh = 0, x; do { x = body[r.p++]; v += (x & 0x7f) * 2 ** sh; sh += 7; } while (x & 0x80);
        out.push(op, ...uleb(mapType(v)));
      }
    } else if (op === 0x10 || op === 0x12 || op === 0xd2) { out.push(op, ...uleb(mapFn(r.uleb()))); }
    else if (op === 0x11 || op === 0x13) { const t = r.uleb(), tb = r.uleb(); out.push(op, ...uleb(mapType(t)), ...uleb(tb)); }
    else if (op === 0x0c || op === 0x0d || op === 0x20 || op === 0x21 || op === 0x22 || op === 0x23 || op === 0x24 || op === 0x25 || op === 0x26) { r.uleb(); copyFrom(s); }
    else if (op === 0x0e) { const n = r.uleb(); for (let i = 0; i <= n; i++) r.uleb(); copyFrom(s); }
    else if (op === 0x1c) { const n = r.uleb(); r.bytes(n); copyFrom(s); }
    else if (op >= 0x28 && op <= 0x3e) { memarg(); copyFrom(s); }
    else if (op === 0x3f || op === 0x40) { r.u8(); copyFrom(s); }
    else if (op === 0x41 || op === 0x42) { let x; do { x = body[r.p++]; } while (x & 0x80); copyFrom(s); }
    else if (op === 0x43) { r.p += 4; copyFrom(s); }
    else if (op === 0x44) { r.p += 8; copyFrom(s); }
    else if (op === 0xd0) { r.u8(); copyFrom(s); }
    else if (op === 0xfc) {
      const sub = r.uleb();
      if (sub === 8) { r.uleb(); r.u8(); } else if (sub === 9 || sub === 13) r.uleb(); else if (sub === 10) { r.u8(); r.u8(); }
      else if (sub === 11) r.u8(); else if (sub === 12 || sub === 14) { r.uleb(); r.uleb(); } else if (sub >= 15 && sub <= 17) r.uleb();
      copyFrom(s);
    } else if (op === 0xfd) {
      const sub = r.uleb();
      if (sub <= 11 || sub === 92 || sub === 93) memarg();
      else if (sub === 12 || sub === 13) r.p += 16;
      else if ((sub >= 21 && sub <= 34)) r.p += 1;
      else if (sub >= 84 && sub <= 91) { memarg(); r.p += 1; }
      copyFrom(s);
    } else if (op <= 0xc4 || op === 0xd1 || op === 0x05 || op === 0x0b || op === 0x0f || op === 0x1a || op === 0x1b || op === 0x00 || op === 0x01) { copyFrom(s); }
    else throw new Error('unknown opcode 0x' + op.toString(16) + ' at ' + s);
  }
  return Uint8Array.from(out);
}

export function link(modules) {
  const ms = modules.map(parse);
  // types
  const types = [], typeKey = new Map();
  const typeMaps = ms.map((m) => m.types.map((t) => { const k = Buffer.from(t).toString('hex'); if (!typeKey.has(k)) { typeKey.set(k, types.length); types.push(t); } return typeKey.get(k); }));
  // imports: union by module.name (functions first so they get the low indices)
  const imps = [], impKey = new Map();
  const addImp = (mi, im) => { const k = im.mod + '\0' + im.name; if (!impKey.has(k)) { impKey.set(k, imps.length); imps.push({ ...im, desc: im.kind === 0 ? typeMaps[mi][im.desc] : im.desc }); } return impKey.get(k); };
  // order: function imports, then the rest, so function indices 0..nImpF-1 are imports
  for (let i = 0; i < ms.length; i++) for (const im of ms[i].imports) if (im.kind === 0) addImp(i, im);
  for (let i = 0; i < ms.length; i++) for (const im of ms[i].imports) if (im.kind !== 0) addImp(i, im);
  const nImpF = imps.filter((x) => x.kind === 0).length;
  // functions
  const funcTypes = [], bodies = [], exportsOut = [], seen = new Set();
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i], impF = m.imports.filter((x) => x.kind === 0);
    const base = nImpF + funcTypes.length;
    const mapFn = (f) => f < impF.length ? impKey.get(impF[f].mod + '\0' + impF[f].name) : base + (f - impF.length);
    const mapType = (t) => typeMaps[i][t];
    for (const t of m.funcs) funcTypes.push(typeMaps[i][t]);
    for (const c of m.codes) bodies.push(rewriteBody(c, mapFn, mapType));
    for (const e of m.exports) if (!seen.has(e.name)) { seen.add(e.name); exportsOut.push({ name: e.name, kind: e.kind, idx: e.kind === 0 ? mapFn(e.idx) : e.idx }); }
  }
  const sec = (id, payload) => cat([Uint8Array.of(id), Uint8Array.from(uleb(payload.length)), payload]);
  const vec = (items) => cat([Uint8Array.from(uleb(items.length)), ...items]);
  const nameB = (s) => { const b = enc.encode(s); return cat([Uint8Array.from(uleb(b.length)), b]); };
  const out = [Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0)];
  out.push(sec(1, vec(types)));
  out.push(sec(2, vec(imps.map((im) => cat([nameB(im.mod), nameB(im.name), Uint8Array.of(im.kind), im.kind === 0 ? Uint8Array.from(uleb(im.desc)) : im.desc])))));
  out.push(sec(3, vec(funcTypes.map((t) => Uint8Array.from(uleb(t))))));
  out.push(sec(7, vec(exportsOut.map((e) => cat([nameB(e.name), Uint8Array.of(e.kind), Uint8Array.from(uleb(e.idx))])))));
  out.push(sec(10, vec(bodies.map((b) => cat([Uint8Array.from(uleb(b.length)), b])))));
  return cat(out);
}

// the walker's self-check: rewriting with identity maps must reproduce every body byte for byte
export function roundTrips(bytes) {
  const m = parse(bytes);
  return m.codes.every((c) => { const o = rewriteBody(c, (x) => x, (x) => x); return o.length === c.length && o.every((v, i) => v === c[i]); });
}

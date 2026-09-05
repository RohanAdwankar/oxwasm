// PCF bitmap font parser — enough of the format to serve X11 core fonts
// (QueryFont metrics + glyph bitmaps for ImageText/PolyText). Handles both
// byte orders, both bit orders, compressed and uncompressed metrics.
const T_METRICS = 4, T_BITMAPS = 8, T_ENCODINGS = 32, T_ACCEL = 2, T_BDF_ACCEL = 256;

export function parsePCF(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (dv.getUint32(0, true) !== 0x70636601) throw new Error('not a PCF');   // "\1fcp"
  const n = dv.getInt32(4, true);
  const toc = [];
  for (let i = 0; i < n; i++)
    toc.push({ type: dv.getInt32(8 + i * 16, true), format: dv.getInt32(12 + i * 16, true),
               size: dv.getInt32(16 + i * 16, true), off: dv.getInt32(20 + i * 16, true) });
  const table = (t) => toc.find(e => e.type === t);

  // ints inside a table follow the table's own format byte order
  const rd = (off) => {
    const fmt = dv.getInt32(off, true);
    const be = !!(fmt & 4);
    return { fmt, be,
      i32: (o) => dv.getInt32(o, !be), i16: (o) => dv.getInt16(o, !be),
      u16: (o) => dv.getUint16(o, !be), u8: (o) => dv.getUint8(o) };
  };

  // metrics
  const mt = table(T_METRICS); if (!mt) throw new Error('PCF: no metrics');
  const M = rd(mt.off);
  const metrics = [];
  if (M.fmt & 0x100) {                                     // compressed
    const count = M.u16(mt.off + 4);
    let o = mt.off + 6;
    for (let i = 0; i < count; i++, o += 5)
      metrics.push({ lsb: M.u8(o) - 0x80, rsb: M.u8(o + 1) - 0x80, width: M.u8(o + 2) - 0x80,
                     ascent: M.u8(o + 3) - 0x80, descent: M.u8(o + 4) - 0x80 });
  } else {
    const count = M.i32(mt.off + 4);
    let o = mt.off + 8;
    for (let i = 0; i < count; i++, o += 12)
      metrics.push({ lsb: M.i16(o), rsb: M.i16(o + 2), width: M.i16(o + 4),
                     ascent: M.i16(o + 6), descent: M.i16(o + 8) });
  }

  // bitmaps
  const bt = table(T_BITMAPS); if (!bt) throw new Error('PCF: no bitmaps');
  const B = rd(bt.off);
  const glyphCount = B.i32(bt.off + 4);
  const offsets = [];
  for (let i = 0; i < glyphCount; i++) offsets.push(B.i32(bt.off + 8 + i * 4));
  const dataStart = bt.off + 8 + glyphCount * 4 + 16;       // skip the 4 size words
  const rowPad = 1 << (B.fmt & 3);                          // bytes each row is padded to
  const msbBits = !!(B.fmt & 8);                            // leftmost pixel in MSB

  // encodings
  const et = table(T_ENCODINGS); if (!et) throw new Error('PCF: no encodings');
  const E = rd(et.off);
  const minB2 = E.u16(et.off + 4), maxB2 = E.u16(et.off + 6);
  const minB1 = E.u16(et.off + 8), maxB1 = E.u16(et.off + 10);
  const defaultChar = E.u16(et.off + 12);
  const encCount = (maxB2 - minB2 + 1) * (maxB1 - minB1 + 1);
  const glyphOf = new Map();                                // char code -> glyph index
  for (let i = 0; i < encCount; i++) {
    const gi = E.u16(et.off + 14 + i * 2);
    if (gi === 0xffff) continue;
    const b1 = minB1 + Math.floor(i / (maxB2 - minB2 + 1));
    const b2 = minB2 + (i % (maxB2 - minB2 + 1));
    glyphOf.set((b1 << 8) | b2, gi);
  }

  // ascent/descent from accelerators
  let fontAscent = 0, fontDescent = 0;
  const at = table(T_BDF_ACCEL) || table(T_ACCEL);
  if (at) { const A = rd(at.off); fontAscent = A.i32(at.off + 12); fontDescent = A.i32(at.off + 16); }
  else { for (const m of metrics) { fontAscent = Math.max(fontAscent, m.ascent); fontDescent = Math.max(fontDescent, m.descent); } }

  // per-glyph bitmap as row-major bit array (1 = pixel set)
  const glyphs = metrics.map((m, gi) => {
    const wbits = m.rsb - m.lsb, rows = m.ascent + m.descent;
    const rowsArr = [];
    const base = dataStart + offsets[gi];
    for (let r = 0; r < rows; r++) {
      const row = new Uint8Array(Math.max(0, wbits));
      for (let x = 0; x < wbits; x++) {
        const byteIdx = base + r * rowBytes(wbits, rowPad) + (x >> 3);
        const b = bytes[byteIdx] ?? 0;
        const bit = msbBits ? (b >> (7 - (x & 7))) & 1 : (b >> (x & 7)) & 1;
        row[x] = bit;
      }
      rowsArr.push(row);
    }
    return { ...m, wbits, rows: rowsArr };
  });
  function rowBytes(wbits, pad) { return Math.ceil(Math.ceil(wbits / 8) / pad) * pad; }

  // min/max bounds for QueryFont
  const bounds = (sel) => metrics.reduce((a, m) => sel(a, m) ? a : m, metrics[0]);
  const agg = (f) => ({ lsb: f(metrics.map(m => m.lsb)), rsb: f(metrics.map(m => m.rsb)),
                        width: f(metrics.map(m => m.width)), ascent: f(metrics.map(m => m.ascent)),
                        descent: f(metrics.map(m => m.descent)) });
  return {
    ascent: fontAscent, descent: fontDescent, defaultChar,
    minBounds: agg(a => Math.min(...a)), maxBounds: agg(a => Math.max(...a)),
    minChar: (minB1 << 8) | minB2, maxChar: (maxB1 << 8) | maxB2,
    glyphOf, glyphs,
    glyph(code) { const gi = this.glyphOf.get(code) ?? this.glyphOf.get(this.defaultChar);
                  return gi === undefined ? null : this.glyphs[gi]; },
    textWidth(str) { let w = 0;
      for (let i = 0; i < str.length; i++) { const g = this.glyph(str.charCodeAt(i)); if (g) w += g.width; }
      return w; },
  };
}

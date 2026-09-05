// oxwasm M3 display layer — a minimal X11 server that lives IN the host
// process (JS), not in the guest. Guest X clients connect through AF_UNIX
// syscalls; requests are parsed here, windows/pixmaps render into typed-array
// framebuffers with a software rasterizer, and the composited screen is a
// Uint32Array the page blits to a canvas. Input (mouse/keyboard) is injected
// by the page and delivered as X events. Only the CORE protocol is served —
// every extension reports absent, which is exactly the fallback path Xlib,
// Xt and GTK were built to handle.
//
// This is the engine's "framebuffer + input" — the guest binary is untouched.

// ---- protocol constants ----------------------------------------------------
const ATOMS = [null, 'PRIMARY','SECONDARY','ARC','ATOM','BITMAP','CARDINAL','COLORMAP','CURSOR',
  'CUT_BUFFER0','CUT_BUFFER1','CUT_BUFFER2','CUT_BUFFER3','CUT_BUFFER4','CUT_BUFFER5','CUT_BUFFER6','CUT_BUFFER7',
  'DRAWABLE','FONT','INTEGER','PIXMAP','POINT','RECTANGLE','RESOURCE_MANAGER','RGB_COLOR_MAP','RGB_BEST_MAP',
  'RGB_BLUE_MAP','RGB_DEFAULT_MAP','RGB_GRAY_MAP','RGB_GREEN_MAP','RGB_RED_MAP','STRING','VISUALID','WINDOW',
  'WM_COMMAND','WM_HINTS','WM_CLIENT_MACHINE','WM_ICON_NAME','WM_ICON_SIZE','WM_NAME','WM_NORMAL_HINTS',
  'WM_SIZE_HINTS','WM_ZOOM_HINTS','MIN_SPACE','NORM_SPACE','MAX_SPACE','END_SPACE','SUPERSCRIPT_X','SUPERSCRIPT_Y',
  'SUBSCRIPT_X','SUBSCRIPT_Y','UNDERLINE_POSITION','UNDERLINE_THICKNESS','STRIKEOUT_ASCENT','STRIKEOUT_DESCENT',
  'ITALIC_ANGLE','X_HEIGHT','QUAD_WIDTH','WEIGHT','POINT_SIZE','RESOLUTION','COPYRIGHT','NOTICE','FONT_NAME',
  'FAMILY_NAME','FULL_NAME','CAP_HEIGHT','WM_CLASS','WM_TRANSIENT_FOR'];

const COLORS = { black:0x000000, white:0xffffff, red:0xff0000, green:0x00ff00, blue:0x0000ff,
  yellow:0xffff00, cyan:0x00ffff, magenta:0xff00ff, gray:0xbebebe, grey:0xbebebe,
  'dark gray':0xa9a9a9, darkgray:0xa9a9a9, 'dark grey':0xa9a9a9, darkgrey:0xa9a9a9,
  'light gray':0xd3d3d3, lightgray:0xd3d3d3, 'light grey':0xd3d3d3, lightgrey:0xd3d3d3,
  'dim gray':0x696969, dimgray:0x696969, gainsboro:0xdcdcdc, 'slate gray':0x708090,
  navy:0x000080, 'navy blue':0x000080, 'midnight blue':0x191970, 'sky blue':0x87ceeb,
  'steel blue':0x4682b4, 'light blue':0xadd8e6, 'royal blue':0x4169e1, 'forest green':0x228b22,
  'dark green':0x006400, 'light yellow':0xffffe0, gold:0xffd700, orange:0xffa500, pink:0xffc0cb,
  brown:0xa52a2a, purple:0xa020f0, violet:0xee82ee, plum:0xdda0dd, salmon:0xfa8072,
  khaki:0xf0e68c, wheat:0xf5deb3, tan:0xd2b48c, beige:0xf5f5dc, ivory:0xfffff0, snow:0xfffafa,
  'ghost white':0xf8f8ff, 'white smoke':0xf5f5f5, 'antique white':0xfaebd7, linen:0xfaf0e6,
  turquoise:0x40e0d0, aquamarine:0x7fffd4, chartreuse:0x7fff00, coral:0xff7f50, maroon:0xb03060 };
function colorByName(name) {
  const n = name.toLowerCase();
  if (COLORS[n] !== undefined) return COLORS[n];
  const g = /^gr[ae]y(\d{1,3})$/.exec(n);
  if (g) { const v = Math.round(Number(g[1]) * 255 / 100); return (v<<16)|(v<<8)|v; }
  return 0x808080;                                       // unknown: mid gray (render over reject)
}

// keycode -> [keysym, shifted]; classic pc105 codes so real apps see a normal keyboard
const SH = { '1':'!', '2':'@', '3':'#', '4':'$', '5':'%', '6':'^', '7':'&', '8':'*', '9':'(', '0':')',
  '-':'_', '=':'+', '[':'{', ']':'}', ';':':', "'":'"', '`':'~', '\\':'|', ',':'<', '.':'>', '/':'?' };
function buildKeymap() {
  const K = {};
  const sym = (c) => c.charCodeAt(0);
  const rows = [[10,'1234567890'], [24,'qwertyuiop'], [38,'asdfghjkl'], [52,'zxcvbnm']];
  for (const [start, chars] of rows)
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      K[start + i] = /[a-z]/.test(c) ? [sym(c), sym(c.toUpperCase())]
                                     : [sym(c), sym(SH[c] ?? c)];
    }
  const punct = { 20:'-', 21:'=', 34:'[', 35:']', 47:';', 48:"'", 49:'`', 51:'\\', 59:',', 60:'.', 61:'/' };
  for (const [k, c] of Object.entries(punct)) K[k] = [sym(c), sym(SH[c] ?? c)];
  K[9] = [0xff1b]; K[22] = [0xff08]; K[23] = [0xff09]; K[36] = [0xff0d]; K[65] = [0x20];
  K[50] = [0xffe1]; K[62] = [0xffe2]; K[37] = [0xffe3]; K[105] = [0xffe4];
  K[64] = [0xffe9]; K[108] = [0xffea]; K[66] = [0xffe5];
  K[111] = [0xff52]; K[113] = [0xff51]; K[114] = [0xff53]; K[116] = [0xff54];
  K[110] = [0xff50]; K[115] = [0xff57]; K[112] = [0xff55]; K[117] = [0xff56];
  K[118] = [0xff63]; K[119] = [0xffff];
  for (let i = 0; i < 12; i++) K[67 + i] = [0xffbe + i];
  return K;
}
const KEYMAP = buildKeymap();

// binary reply/event writer
class W {
  constructor(n) { this.b = new Uint8Array(n); this.v = new DataView(this.b.buffer); }
  u8(o, x) { this.v.setUint8(o, x); return this; }
  u16(o, x) { this.v.setUint16(o, x & 0xffff, true); return this; }
  i16(o, x) { this.v.setInt16(o, x, true); return this; }
  u32(o, x) { this.v.setUint32(o, x >>> 0, true); return this; }
  i32(o, x) { this.v.setInt32(o, x, true); return this; }
}
const pad4 = (n) => (n + 3) & ~3;

// ---- the server ------------------------------------------------------------
import { builtinFont } from './font5x7.mjs';

// Debug hooks read from the environment ONCE, behind typeof: `process` is
// not declared in a browser, and `process?.env` still throws ReferenceError
// there. A per-request read of it in the atom/font handlers took every
// InternAtom and OpenFont down in the packed GIMP page - the File menu never
// appeared - from 855590d until this line.
const XFONTTRACE = typeof process !== 'undefined' && !!process.env?.XFONTTRACE;
const XFONTDBG = typeof process !== 'undefined' && !!process.env?.XFONTDBG;

export class XServer {
  constructor({ width = 800, height = 600, fonts = {} } = {}) {
    this.W = width; this.H = height;
    this.fb = new Uint32Array(width * height);           // composited screen, 0xRRGGBB
    this.dirty = true;
    this.atoms = ATOMS.slice();                          // index = atom id
    this.res = new Map();                                // id -> resource
    this.conns = [];
    this.timeBase = Date.now();
    // fonts: name -> parsed PCF; register XLFD-ish aliases
    this.fonts = [];
    for (const [name, f] of Object.entries(fonts)) this.fonts.push({ names: [name.toLowerCase()], font: f });
    // Last-resort core font. Athena/Xt clients (xmessage, xfontsel, xclock,
    // xedit) load a SERVER-side font at startup and abort with "Unable to
    // load any usable ISO8859 font" if there is none; GTK apps never showed
    // this because Xft rasterizes client-side. Appended AFTER the supplied
    // PCFs so a real font always wins the match, and it only ever answers
    // requests that would otherwise have found nothing.
    this.fonts.push({ names: ['builtin5x7'], font: builtinFont(), builtin: true });
    this.defaultFont = this.fonts[0]?.font ?? null;
    const alias = (pat, key) => { const e = this.fonts.find(e => e.names.includes(key)); if (e) e.names.push(pat); };
    alias('fixed', '6x13'); alias('variable', '6x13'); alias('cursor', 'cursor');
    // a well-formed XLFD name so XCreateFontSet (Xt/Xaw fontsets) can parse
    // charset fields out of what ListFonts returns
    alias('-misc-fixed-medium-r-normal--13-120-75-75-c-60-iso8859-1', '6x13');
    { const bi = this.fonts[this.fonts.length - 1];
      const claimed = new Set(this.fonts.flatMap(e => e === bi ? [] : e.names));
      for (const n of ['fixed', 'variable', 'cursor', '6x13', '9x15', '5x7',
                       '-misc-fixed-medium-r-normal--13-120-75-75-c-60-iso8859-1'])
        if (!claimed.has(n)) bi.names.push(n); }
    // window tree
    this.rootId = 0x266;
    this.root = { id: this.rootId, parent: null, x: 0, y: 0, w: width, h: height, bw: 0,
                  cls: 1, depth: 24, mapped: true, bgPixel: 0x9a9a9a, borderPixel: 0,
                  eventMask: 0, dnp: 0, override: false, props: new Map(), children: [],
                  buffer: null, conn: null };
    this.res.set(this.rootId, this.root);
    this.ptr = { x: width >> 1, y: height >> 1, buttons: 0, state: 0 };
    this.keysDown = new Set();
    this.focus = this.rootId;                            // PointerRoot-ish: we route by pointer
    this.grabWindow = null;                              // (legacy snapshot field)
    this.grab = null;                                    // pointer grab: { win, mask, ownerEvents, implicit }
  }

  now() { return (Date.now() - this.timeBase) & 0x7fffffff; }
  atom(name, create = true) {
    const i = this.atoms.indexOf(name);
    if (i >= 0) return i;
    if (!create) return 0;
    this.atoms.push(name); return this.atoms.length - 1;
  }

  connect() {
    const s = this;
    const conn = {
      seq: 0, inbuf: new Uint8Array(0), setupDone: false, out: [], outOff: 0,
      ridBase: 0x200000 * (this.conns.length + 1),
      write(bytes) { s.clientData(this, bytes); },
      read(max) {
        if (!this.out.length) return null;
        const head = this.out[0], avail = head.length - this.outOff;
        const take = Math.min(avail, max);
        const r = head.subarray(this.outOff, this.outOff + take);
        this.outOff += take;
        if (this.outOff >= head.length) { this.out.shift(); this.outOff = 0; }
        return r;
      },
      readable() { return this.out.length > 0; },
      send(bytes) { this.out.push(bytes); },
    };
    this.conns.push(conn);
    return conn;
  }

  // ---- wire: parse client bytes into requests ------------------------------
  clientData(conn, bytes) {
    const merged = new Uint8Array(conn.inbuf.length + bytes.length);
    merged.set(conn.inbuf); merged.set(bytes, conn.inbuf.length);
    conn.inbuf = merged;
    for (;;) {
      const b = conn.inbuf;
      if (!conn.setupDone) {
        if (b.length < 12) return;
        const v = new DataView(b.buffer, b.byteOffset);
        const nAuth = v.getUint16(6, true), dAuth = v.getUint16(8, true);
        const need = 12 + pad4(nAuth) + pad4(dAuth);
        if (b.length < need) return;
        conn.inbuf = b.subarray(need);
        conn.setupDone = true;
        conn.send(this.setupReply(conn));
        continue;
      }
      if (b.length < 4) return;
      const v = new DataView(b.buffer, b.byteOffset);
      const len = v.getUint16(2, true) * 4;
      if (len === 0) { conn.inbuf = b.subarray(4); conn.len0 = (conn.len0 || 0) + 1; continue; }   // malformed; skip
      if (b.length < len) return;
      const req = b.subarray(0, len);
      conn.inbuf = b.subarray(len);
      conn.seq = (conn.seq + 1) & 0xffff;
      const rec = { op: req[0], seq: conn.seq, q: conn.out.length, sent: 0, err: 0 };
      (conn.ring ??= []).push(rec); if (conn.ring.length > 16) conn.ring.shift();
      try { this.handle(conn, req); }
      catch (e) { rec.err = 1; this.error(conn, 17, 0, req[0]); }            // BadImplementation
      rec.sent = conn.out.length - rec.q;
    }
  }
  diag() {
    return this.conns.map((c, i) =>
      `conn${i} seq=${c.seq} inbuf=${c.inbuf.length} out=${c.out.length} len0=${c.len0 || 0} ring=` +
      (c.ring ?? []).map(r => `${r.op}@${r.seq}${r.sent ? '+' + r.sent : ''}${r.err ? 'E' : ''}`).join(','));
  }

  setupReply(conn) {
    const vendor = 'oxwasm';
    const extra = 8 + 4 * 2 + pad4(vendor.length) + 2 * 8 + 40 + 8 + 24;
    const w = new W(8 + 32 + pad4(vendor.length) + 16 + 40 + 8 + 24);
    let o = 0;
    w.u8(0, 1); w.u16(2, 11); w.u16(4, 0);
    w.u16(6, (w.b.length - 8) / 4);
    w.u32(8, 12000000);                                  // release
    w.u32(12, conn.ridBase); w.u32(16, 0x1fffff);        // resource id base/mask
    w.u32(20, 0);                                        // motion buffer
    w.u16(24, vendor.length); w.u16(26, 0xffff);         // max request length
    w.u8(28, 1); w.u8(29, 2);                            // 1 screen, 2 pixmap formats
    w.u8(30, 0); w.u8(31, 0);                            // LSBFirst image + bitmap bit order
    w.u8(32, 32); w.u8(33, 32);                          // scanline unit/pad
    w.u8(34, 8); w.u8(35, 255);                          // min/max keycode
    o = 40;
    for (let i = 0; i < vendor.length; i++) w.u8(o + i, vendor.charCodeAt(i));
    o += pad4(vendor.length);
    w.u8(o, 1); w.u8(o + 1, 1); w.u8(o + 2, 32); o += 8;         // format: depth1 bpp1
    w.u8(o, 24); w.u8(o + 1, 32); w.u8(o + 2, 32); o += 8;       // format: depth24 bpp32
    // screen
    w.u32(o, this.rootId); w.u32(o + 4, 0x23);           // root, default colormap
    w.u32(o + 8, 0xffffff); w.u32(o + 12, 0x000000);     // white, black
    w.u32(o + 16, 0);                                    // current input masks
    w.u16(o + 20, this.W); w.u16(o + 22, this.H);
    w.u16(o + 24, Math.round(this.W / 3.78)); w.u16(o + 26, Math.round(this.H / 3.78));
    w.u16(o + 28, 1); w.u16(o + 30, 1);                  // min/max installed maps
    w.u32(o + 32, 0x22);                                 // root visual
    w.u8(o + 36, 0); w.u8(o + 37, 0); w.u8(o + 38, 24); w.u8(o + 39, 1);   // backing/saveunders/depth/ndepths
    o += 40;
    w.u8(o, 24); w.u16(o + 2, 1); o += 8;                // depth 24, 1 visual
    w.u32(o, 0x22); w.u8(o + 4, 4); w.u8(o + 5, 8);      // TrueColor, 8 bits/rgb
    w.u16(o + 6, 256);
    w.u32(o + 8, 0xff0000); w.u32(o + 12, 0x00ff00); w.u32(o + 16, 0x0000ff);
    return w.b;
  }

  reply(conn, seqLike, byte1, extraBytes, fill) {
    const extra = pad4(extraBytes);
    const w = new W(32 + extra);
    w.u8(0, 1); w.u8(1, byte1); w.u16(2, conn.seq); w.u32(4, extra / 4);
    if (fill) fill(w);
    conn.send(w.b);
  }
  error(conn, code, bad, major) {
    const w = new W(32);
    w.u8(0, 0); w.u8(1, code); w.u16(2, conn.seq); w.u32(4, bad >>> 0); w.u8(10, major);
    conn.send(w.b);
  }
  event(conn, bytes) { conn.send(bytes); }

  // ---- resources -----------------------------------------------------------
  win(id) { const r = this.res.get(id); return r && r.cls !== undefined ? r : null; }
  drawable(id) { const r = this.res.get(id); return r && (r.cls !== undefined || r.pixmap) ? r : null; }
  gcOf(id) { const r = this.res.get(id); return r && r.gc ? r : null; }
  absPos(w) { let x = 0, y = 0; for (let p = w; p; p = p.parent ? this.win(p.parent) : null) { x += p.x; y += p.y; } return { x, y }; }

  windowAt(x, y) {                                       // deepest mapped window containing point
    const descend = (w, wx, wy) => {
      for (let i = w.children.length - 1; i >= 0; i--) {
        const c = w.children[i];
        if (!c.mapped) continue;
        const cx = wx + c.x, cy = wy + c.y;
        if (x >= cx && x < cx + c.w && y >= cy && y < cy + c.h)
          return descend(c, cx, cy);
      }
      return { w, wx, wy };
    };
    return descend(this.root, 0, 0);
  }

  // ---- micro-WM ------------------------------------------------------------
  // There is no external window manager, so managed toplevels (mapped,
  // non-override children of root) get a server-drawn title strip above
  // their frame: drag it to move, press it (or the window body) to raise.
  // Moves are pure server-side state — the compositor repaints from window
  // buffers, so the guest only sees a ConfigureNotify.
  wmManaged(c) { return !!(c.mapped && !c.override && c.cls !== 2 && c.buffer && c.conn && c.w >= 60); }
  wmName(w) {
    const p = w.props?.get(39);                            // WM_NAME
    const v = p?.data ?? (p?.length !== undefined ? p : null);   // live {type,fmt,data} vs restored raw bytes
    if (!v || !v.length) return '';
    let s = ''; for (let i = 0; i < Math.min(v.length, 60); i++) s += String.fromCharCode(v[i]);
    return s;
  }
  wmStrip(c) {
    const TH = 18, x0 = Math.max(0, c.x), x1 = Math.min(this.W, c.x + c.w);
    const y0 = Math.max(0, c.y - TH), y1 = Math.min(this.H, c.y);
    for (let y = y0; y < y1; y++) {
      const edge = y === y0 || y === y1 - 1;
      for (let x = x0; x < x1; x++)
        this.fb[y * this.W + x] = (edge || x === x0 || x === x1 - 1) ? 0x1e2836 : 0x33415e;
    }
    const f = this.defaultFont;
    if (f && y1 - y0 > 12) {
      const name = this.wmName(c) || '(untitled)';
      let x = x0 + 6; const base = y0 + 13;
      for (let i = 0; i < name.length && x < x1 - 10; i++) {
        const g = f.glyph(name.charCodeAt(i));
        if (!g) continue;
        for (let r = 0; r < g.rows.length; r++) {
          const row = g.rows[r];
          for (let cc = 0; cc < row.length; cc++)
            if (row[cc]) this.px(x + g.lsb + cc, base - g.ascent + r, 0xe8edf5);
        }
        x += g.width;
      }
    }
  }
  wmStripAt(x, y) {                                        // topmost-first; a window body occludes lower strips
    const TH = 18, cs = this.root.children;
    for (let i = cs.length - 1; i >= 0; i--) {
      const c = cs[i];
      if (!c.mapped) continue;
      if (x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h) return null;
      if (this.wmManaged(c) && x >= c.x && x < c.x + c.w && y >= c.y - TH && y < c.y) return c;
    }
    return null;
  }
  wmRaise(c) {
    const cs = this.root.children;
    if (cs[cs.length - 1] === c) return;
    this.root.children = cs.filter(w => w !== c); this.root.children.push(c);
    this.dirty = true;
  }
  wmConfigureNotify(w) {
    if (this.wmNoCfg) return;
    // synthetic (send_event) per ICCCM: a WM-moved window's coordinates are
    // authoritative root-relative — GTK then skips its QueryTree
    // frame-extents dance (observed: 200k QueryTrees after a real one)
    this.notify(w, (ev) => { const e = new W(32);
      e.u8(0, 22 | 0x80); e.u32(4, ev); e.u32(8, w.id); e.u32(12, 0);
      e.i16(16, w.x); e.i16(18, w.y); e.u16(20, w.w); e.u16(22, w.h);
      e.u16(24, w.bw); e.u8(26, w.override ? 1 : 0); return e; });
  }
  wmToplevelOf(w) {
    let t = w, p = t && t.parent ? this.win(t.parent) : null;
    while (p && p !== this.root) { t = p; p = t.parent ? this.win(t.parent) : null; }
    return p === this.root ? t : null;
  }

  // ---- compositing ---------------------------------------------------------
  flush() {
    this.fb.fill(this.root.bgPixel);
    const paint = (w, ax, ay) => {
      if (!w.mapped) return;
      if (w._hideUntilDrawn) { if (!w._drawn) return; w._hideUntilDrawn = false; }
      if (w.cls !== 2 && w.buffer) {
        if (w.bw > 0) {                                   // border frame outside the window
          for (let i = 0; i < w.bw; i++) {
            this.frameRect(ax - w.bw + i, ay - w.bw + i,
                           w.w + 2 * (w.bw - i), w.h + 2 * (w.bw - i), w.borderPixel);
          }
        }
        const x0 = Math.max(0, ax), y0 = Math.max(0, ay);
        const x1 = Math.min(this.W, ax + w.w), y1 = Math.min(this.H, ay + w.h);
        for (let y = y0; y < y1; y++) {
          const src = (y - ay) * w.w + (x0 - ax), dst = y * this.W + x0;
          this.fb.set(w.buffer.subarray(src, src + (x1 - x0)), dst);
        }
      }
      for (const c of w.children) paint(c, ax + c.x, ay + c.y);
    };
    for (const c of this.root.children) {
      paint(c, c.x, c.y);
      if (!this.noWM && this.wmManaged(c) && !(c._hideUntilDrawn && !c._drawn))
        this.wmStrip(c);                                  // strip stacks with its window
    }
    this.dirty = false;
    return this.fb;
  }
  frameRect(x, y, w, h, pix) {
    for (let i = 0; i < w; i++) { this.px(x + i, y, pix); this.px(x + i, y + h - 1, pix); }
    for (let i = 0; i < h; i++) { this.px(x, y + i, pix); this.px(x + w - 1, y + i, pix); }
  }
  px(x, y, pix) { if (x >= 0 && y >= 0 && x < this.W && y < this.H) this.fb[y * this.W + x] = pix; }

  // ---- input injection -----------------------------------------------------
  inputEvent(code, detail, target) {
    const { w, wx, wy } = target ?? this.windowAt(this.ptr.x, this.ptr.y);
    // propagate up until a window selects the event's mask
    const MASK = { 2: 1, 3: 2, 4: 4, 5: 8, 6: 0x40 | 0x2000 }[code];
    const selects = (ww) => code === 6
      ? (ww.eventMask & 0x40) || (this.ptr.buttons && (ww.eventMask & 0x2000))
      : (ww.eventMask & MASK);
    let ww = w, ax = wx, ay = wy;
    while (ww && !selects(ww)) {
      if (ww.dnp & MASK) return;
      ww = ww.parent ? this.win(ww.parent) : null;
      if (ww) { const a = this.absPos(ww); ax = a.x; ay = a.y; }
    }
    // pointer grab (active via GrabPointer, or implicit while a button is
    // held): pointer events route to the grab window under the GRAB's event
    // mask — GIMP's canvas drag depends on this, since the canvas window
    // itself doesn't select motion outside the grab. owner-events: normal
    // delivery wins when it lands in one of the grabbing client's windows.
    const g = code >= 4 && code <= 6 && !this.disableGrabs ? this.grab : null;
    if (g && this.win(g.win.id)) {
      if (!(g.ownerEvents && ww && ww.conn === g.win.conn)) {
        const m = g.mask;
        const wants = code === 4 ? (m & 4) || true       // press: always reported
          : code === 5 ? (m & 8)
          : (m & 0x40) || (this.ptr.buttons && (m & 0x2000)) ||
            (m & (this.ptr.buttons << 8));               // ButtonN-motion masks
        if (!wants) return;
        ww = g.win;
        const a = this.absPos(ww); ax = a.x; ay = a.y;
      }
    }
    if (!ww || !ww.conn) { if (this.dbgInput) console.error(`<xev code=${code} DROPPED (no window/conn)>`); return; }
    if (this.dbgInput && code !== 6) console.error(`<xev code=${code} det=${detail} -> win=0x${ww.id.toString(16)} mask=0x${(ww.eventMask ?? 0).toString(16)} grab=${this.grab ? (this.grab.implicit ? 'impl' : 'act') + ':0x' + this.grab.win.id.toString(16) + '/m0x' + this.grab.mask.toString(16) + (this.grab.ownerEvents ? '/oe' : '') : 'no'}>`);
    if (this.dbgInput === 3 && code === 4) {
      const a0 = this.absPos(ww);
      console.error(`<press@${this.ptr.x},${this.ptr.y} on 0x${ww.id.toString(16)} abs=${a0.x},${a0.y} ${ww.w}x${ww.h}; children:`);
      for (const c of ww.children) console.error(`  0x${c.id.toString(16)} @${c.x},${c.y} ${c.w}x${c.h} cls=${c.cls} mapped=${c.mapped} mask=0x${(c.eventMask ?? 0).toString(16)} kids=${c.children.length}>`);
    }
    if (this.dbgInput === 2 && code === 6) console.error(`<xev motion -> win=0x${ww.id.toString(16)}>`);
    const w32 = new W(32);
    w32.u8(0, code); w32.u8(1, detail); w32.u16(2, ww.conn.seq);
    w32.u32(4, this.now()); w32.u32(8, this.rootId); w32.u32(12, ww.id);
    w32.u32(16, 0);                                      // child: none (good enough)
    w32.i16(20, this.ptr.x); w32.i16(22, this.ptr.y);
    w32.i16(24, this.ptr.x - ax); w32.i16(26, this.ptr.y - ay);
    w32.u16(28, this.ptr.state); w32.u8(30, 1);
    this.event(ww.conn, w32.b);
  }
  injectMotion(x, y) {
    x = Math.max(0, Math.min(this.W - 1, x | 0)); y = Math.max(0, Math.min(this.H - 1, y | 0));
    if (x === this.ptr.x && y === this.ptr.y) return;
    if (this.wmDrag) {                                     // server-side move; the guest sees only ConfigureNotify
      this.ptr.x = x; this.ptr.y = y;
      const w = this.wmDrag.w;
      w.x = Math.max(-(w.w - 40), Math.min(this.W - 40, x - this.wmDrag.dx));
      w.y = Math.max(18, Math.min(this.H - 4, y - this.wmDrag.dy));
      this.wmConfigureNotify(w);
      this.dirty = true;
      return;
    }
    const before = this.windowAt(this.ptr.x, this.ptr.y).w;
    this.ptr.x = x; this.ptr.y = y;
    const at = this.windowAt(x, y);
    if (before !== at.w) {                               // crossing events
      this.crossing(8, before);                          // LeaveNotify
      this.crossing(7, at.w);                            // EnterNotify
    }
    this.inputEvent(6, 0, at);
  }
  crossing(code, w) {
    const mask = code === 7 ? 0x10 : 0x20;
    if (!w || !w.conn || !(w.eventMask & mask)) return;
    const a = this.absPos(w);
    const e = new W(32);
    e.u8(0, code); e.u8(1, 0); e.u16(2, w.conn.seq);
    e.u32(4, this.now()); e.u32(8, this.rootId); e.u32(12, w.id); e.u32(16, 0);
    e.i16(20, this.ptr.x); e.i16(22, this.ptr.y);
    e.i16(24, this.ptr.x - a.x); e.i16(26, this.ptr.y - a.y);
    e.u16(28, this.ptr.state); e.u8(30, 0); e.u8(31, 2);
    this.event(w.conn, e.b);
  }
  injectButton(button, down) {
    const bit = 0x100 << (button - 1);
    if (!this.noWM) {
      if (down && button === 1 && !this.ptr.buttons) {
        const strip = this.wmStripAt(this.ptr.x, this.ptr.y);
        if (strip) {                                     // begin server-side title drag (event swallowed)
          this.wmRaise(strip);
          this.wmDrag = { w: strip, dx: this.ptr.x - strip.x, dy: this.ptr.y - strip.y };
          this.ptr.buttons |= 1; this.ptr.state |= bit;
          return;
        }
        const top = this.wmToplevelOf(this.windowAt(this.ptr.x, this.ptr.y).w);
        if (top && this.wmManaged(top)) this.wmRaise(top);   // click-to-raise; event still delivered
      }
      if (!down && this.wmDrag) {                        // end title drag (release swallowed)
        this.wmDrag = null;
        this.ptr.state &= ~bit; this.ptr.buttons &= ~(1 << (button - 1));
        return;
      }
    }
    if (down) {
      this.ptr.buttons |= 1 << (button - 1);
      if (!this.grab) {                                  // implicit grab: press window + its mask
        let ww = this.windowAt(this.ptr.x, this.ptr.y).w;
        while (ww && !(ww.eventMask & 4)) ww = ww.parent ? this.win(ww.parent) : null;
        if (ww && ww.conn) this.grab = { win: ww, mask: ww.eventMask, ownerEvents: false, implicit: true };
      }
    }
    this.inputEvent(down ? 4 : 5, button);
    if (down) this.ptr.state |= bit; else {
      this.ptr.state &= ~bit; this.ptr.buttons &= ~(1 << (button - 1));
      if (!this.ptr.buttons && this.grab?.implicit) this.grab = null;
    }
  }
  injectKey(keycode, down) {
    if (down) this.keysDown.add(keycode); else this.keysDown.delete(keycode);
    const mod = { 50: 1, 62: 1, 66: 2, 37: 4, 105: 4, 64: 8, 108: 8 }[keycode];
    if (mod !== undefined) { if (down) this.ptr.state |= mod; else this.ptr.state &= ~mod; }
    this.inputEvent(down ? 2 : 3, keycode);
  }

  // ---- notify events -------------------------------------------------------
  notify(w, build) {                                     // StructureNotify to self, SubstructureNotify to parent
    if (w.conn && (w.eventMask & 0x20000)) { const e = build(w.id); e.u16(2, w.conn.seq); this.event(w.conn, e.b); }
    const p = w.parent ? this.win(w.parent) : null;
    if (p && p.conn && (p.eventMask & 0x80000)) { const e = build(p.id); e.u16(2, p.conn.seq); this.event(p.conn, e.b); }
  }
  // A window that disappears (unmap/destroy) uncovers what it hid: real X
  // sends Expose to everything beneath — GTK repaints on that, and without
  // it the stale pixels sit until the app's next self-refresh (measured:
  // menu close took ~4s, riding GIMP's own heartbeat). Uses the class's
  // existing absPos ({x,y}) — a redefinition here once shadowed it and
  // silently broke every input event's coordinates.
  uncover(w) {
    if (this.noUncover) return;
    const { x: ax, y: ay } = this.absPos(w);
    for (const c of this.root.children ?? []) {
      if (c === w || !c.mapped) continue;
      const { x: cx, y: cy } = this.absPos(c);
      const ix = Math.max(ax, cx), iy = Math.max(ay, cy);
      const iw = Math.min(ax + w.w, cx + c.w) - ix, ih = Math.min(ay + w.h, cy + c.h) - iy;
      if (iw > 0 && ih > 0) this.expose(c, ix - cx, iy - cy, iw, ih);
    }
  }
  expose(w, x, y, ww, hh) {
    if (XFONTTRACE)
      console.error(`<xexpose 0x${w.id.toString(16)} ${ww}x${hh} mask=0x${(w.eventMask||0).toString(16)}`
        + `${!w.conn ? ' NOCONN' : ''}${!(w.eventMask & 0x8000) ? ' NO-EXPOSUREMASK' : ''}>`);
    if (!w.conn || !(w.eventMask & 0x8000)) return;
    const e = new W(32);
    e.u8(0, 12); e.u16(2, w.conn.seq); e.u32(4, w.id);
    e.u16(8, x); e.u16(10, y); e.u16(12, ww); e.u16(14, hh); e.u16(16, 0);
    this.event(w.conn, e.b);
  }

  // ---- request dispatch ----------------------------------------------------
  handle(conn, req) {
    const v = new DataView(req.buffer, req.byteOffset, req.length);
    const op = req[0], d1 = req[1];
    // XFONTTRACE=1 logs every font request with the name or pattern asked
    // for. XCreateFontSet failing shows up here as the pattern Xlib probes;
    // wrapping handle() from outside a test turned out not to work, so the
    // hook lives in the server.
    if (XFONTTRACE && (op === 16 || op === 17)) {
      if (op === 17) console.error(`<xfont GetAtomName ${v.getUint32(4, true)} -> ${this.atoms[v.getUint32(4, true)] ?? '(none)'}>`);
      else { let n = ''; const ln = v.getUint16(4, true); for (let i = 0; i < ln; i++) n += String.fromCharCode(req[8 + i]);
             console.error(`<xfont InternAtom "${n}">`); }
    }
    if (XFONTTRACE && (op === 74 || op === 76 || op === 75 || op === 77)) {
      // what text actually reaches the server, and for which drawable
      let t = '';
      if (op === 76 || op === 77) { const n = req[1];
        for (let i = 0; i < n; i++) t += String.fromCharCode(req[16 + (op === 77 ? i * 2 + 1 : i)]); }
      else { const n = req[16];                       // first TEXTITEM8: len, delta, string
        for (let i = 0; i < n && 18 + i < req.length; i++) t += String.fromCharCode(req[18 + i]); }
      console.error(`<xtext op=${op} drawable=0x${v.getUint32(4, true).toString(16)} "${t}">`);
    }
    if (XFONTTRACE && op >= 45 && op <= 52) {
      const NM = { 45:'OpenFont', 46:'CloseFont', 47:'QueryFont', 48:'QueryTextExtents',
                   49:'ListFonts', 50:'ListFontsWithInfo', 51:'SetFontPath', 52:'GetFontPath' };
      let txt = '';
      const str = (o, n) => { let r = ''; for (let i = 0; i < n; i++) r += String.fromCharCode(req[o + i]); return r; };
      if (op === 45) txt = str(12, v.getUint16(8, true));
      else if (op === 49 || op === 50) txt = str(8, v.getUint16(6, true));
      console.error(`<xfont ${NM[op]}${txt ? ' "' + txt + '"' : ''}>`);
    }
    if (this.countOps) {
      this.opCount[op] = (this.opCount[op] || 0) + 1;
      if (op === 72) {                                   // PutImage: any non-white pixels?
        const wd = v.getUint16(12, true), ht = v.getUint16(14, true);
        let dark = 0;
        for (let o = 24; o + 4 <= req.length; o += 4)
          if ((v.getUint32(o, true) & 0xffffff) !== 0xffffff) dark++;
        console.error(`<PutImage dst=0x${v.getUint32(4, true).toString(16)} ${wd}x${ht}@${v.getInt16(16, true)},${v.getInt16(18, true)} dark=${dark}>`);
      }
      if (op === 62) {                                   // CopyArea: where do pixels flow?
        const kind = (id) => { const r = this.res.get(id);
          return !r ? '?' : r.children !== undefined ? 'win' : 'pix'; };
        const s = v.getUint32(4, true), d = v.getUint32(8, true);
        console.error(`<CopyArea 0x${s.toString(16)}(${kind(s)})@${v.getInt16(16, true)},${v.getInt16(18, true)} -> 0x${d.toString(16)}(${kind(d)})@${v.getInt16(20, true)},${v.getInt16(22, true)} ${v.getUint16(24, true)}x${v.getUint16(26, true)}>`);
      }
    }
    const u8 = (o) => v.getUint8(o), u16 = (o) => v.getUint16(o, true),
          i16 = (o) => v.getInt16(o, true), u32 = (o) => v.getUint32(o, true),
          i32 = (o) => v.getInt32(o, true);
    const str = (o, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(req[o + i]); return s; };
    const S = this;

    switch (op) {
      case 1: {                                          // CreateWindow
        const wid = u32(4), parent = u32(8);
        const p = this.win(parent);
        const win = { id: wid, parent, x: i16(12), y: i16(14), w: u16(16), h: u16(18),
          bw: u16(20), cls: u16(22) || 1, depth: d1 || 24, mapped: false,
          bgPixel: 0xffffff, bgNone: true, borderPixel: 0, eventMask: 0, dnp: 0,
          override: false, props: new Map(), children: [], conn,
          buffer: new Uint32Array(Math.max(1, u16(16) * u16(18))) };
        this.applyWinAttrs(win, u32(28), req, 32, v);
        if (!win.bgNone) win.buffer.fill(win.bgPixel);
        this.res.set(wid, win);
        if (p) p.children.push(win);
        break; }
      case 2: {                                          // ChangeWindowAttributes
        const w = this.win(u32(4)); if (!w) break;
        if (w.conn === null) w.conn = conn;              // selecting on root
        this.applyWinAttrs(w, u32(8), req, 12, v);
        break; }
      case 3: {                                          // GetWindowAttributes (44-byte reply)
        const w = this.win(u32(4));
        this.reply(conn, 0, 0, 12, (r) => {
          r.u32(8, 0x22); r.u16(12, w?.cls ?? 1);
          r.u8(14, 0); r.u8(15, 1);
          r.u8(24, 0); r.u8(25, 1); r.u8(26, w?.mapped ? 2 : 0); r.u8(27, w?.override ? 1 : 0);
          r.u32(28, 0x23);
          r.u32(32, w?.eventMask ?? 0); r.u32(36, w?.eventMask ?? 0); r.u16(40, w?.dnp ?? 0);
        });
        break; }
      case 4: {                                          // DestroyWindow
        const w = this.win(u32(4)); if (!w || w === this.root) break;
        const wasMapped = w.mapped;
        this.destroyWin(w); this.dirty = true;
        if (wasMapped) this.uncover(w);
        break; }
      case 5: break;                                     // DestroySubwindows
      case 6: break;                                     // ChangeSaveSet
      case 7: {                                          // ReparentWindow
        const w = this.win(u32(4)), np = this.win(u32(8));
        if (!w || !np) break;
        const op_ = this.win(w.parent); if (op_) op_.children = op_.children.filter(c => c !== w);
        w.parent = np.id; w.x = i16(12); w.y = i16(14); np.children.push(w);
        this.dirty = true; break; }
      case 8: {                                          // MapWindow
        const w = this.win(u32(4)); if (!w || w.mapped) break;
        w.mapped = true; this.dirty = true;
        // A window that has never been drawn composites as a black slab while
        // the guest renders (menus took ~1s to fill), so it is hidden until
        // first ink — but only when it has NO background. With a background
        // pixel the buffer was already filled at creation, so there is
        // nothing to hide and the window is legitimately just its background.
        // Hiding those too suppressed every Athena toplevel (and, since
        // flush() skips a hidden window's children, everything inside it):
        // xmessage mapped, drew, and still composited to a bare root.
        if (!w._drawn && w.bgNone) w._hideUntilDrawn = true;
        // on-screen placement: keep a managed toplevel's title strip reachable
        if (!this.noWM && !w.override && w.parent === this.rootId && w.conn && w.w >= 60) {
          const nx = Math.max(-(w.w - 40), Math.min(this.W - 40, w.x));
          const ny = Math.max(18, Math.min(this.H - 4, w.y));
          if (nx !== w.x || ny !== w.y) { w.x = nx; w.y = ny; this.wmConfigureNotify(w); }
        }
        this.notify(w, (ev) => { const e = new W(32); e.u8(0, 19); e.u32(4, ev); e.u32(8, w.id); e.u8(12, w.override ? 1 : 0); return e; });
        this.expose(w, 0, 0, w.w, w.h);
        break; }
      case 9: {                                          // MapSubwindows
        const w = this.win(u32(4)); if (!w) break;
        for (const c of w.children) if (!c.mapped) { c.mapped = true; this.expose(c, 0, 0, c.w, c.h); }
        this.dirty = true; break; }
      case 10: {                                         // UnmapWindow
        const w = this.win(u32(4)); if (!w || !w.mapped) break;
        w.mapped = false; this.dirty = true;
        this.notify(w, (ev) => { const e = new W(32); e.u8(0, 18); e.u32(4, ev); e.u32(8, w.id); return e; });
        this.uncover(w);
        break; }
      case 11: break;                                    // UnmapSubwindows
      case 12: {                                         // ConfigureWindow
        const w = this.win(u32(4)); if (!w) break;
        const mask = u16(8); let o = 12;
        let nx = w.x, ny = w.y, nw = w.w, nh = w.h, nbw = w.bw;
        if (mask & 1) { nx = i32(o); o += 4; }
        if (mask & 2) { ny = i32(o); o += 4; }
        if (mask & 4) { nw = i32(o); o += 4; }
        if (mask & 8) { nh = i32(o); o += 4; }
        if (mask & 16) { nbw = i32(o); o += 4; }
        if (mask & 32) o += 4;                           // sibling
        if (mask & 64) {                                 // stack mode: Above -> raise
          const p = this.win(w.parent);
          if (p) { p.children = p.children.filter(c => c !== w); p.children.push(w); }
          o += 4;
        }
        const resized = nw !== w.w || nh !== w.h;
        w.x = nx; w.y = ny; w.bw = nbw;
        if (resized) {
          const nb = new Uint32Array(Math.max(1, nw * nh));
          if (!w.bgNone) nb.fill(w.bgPixel);
          for (let yy = 0; yy < Math.min(w.h, nh); yy++)
            nb.set(w.buffer.subarray(yy * w.w, yy * w.w + Math.min(w.w, nw)), yy * nw);
          w.w = nw; w.h = nh; w.buffer = nb;
        }
        this.notify(w, (ev) => { const e = new W(32);
          e.u8(0, 22); e.u32(4, ev); e.u32(8, w.id); e.u32(12, 0);
          e.i16(16, w.x); e.i16(18, w.y); e.u16(20, w.w); e.u16(22, w.h);
          e.u16(24, w.bw); e.u8(26, w.override ? 1 : 0); return e; });
        if (resized && w.mapped) this.expose(w, 0, 0, w.w, w.h);
        this.dirty = true; break; }
      case 13: break;                                    // CirculateWindow
      case 14: {                                         // GetGeometry
        const d = this.drawable(u32(4));
        this.reply(conn, 0, d?.depth ?? 24, 0, (r) => {
          r.u32(8, this.rootId);
          const a = d && d.cls !== undefined ? { x: d.x, y: d.y } : { x: 0, y: 0 };
          r.i16(12, a.x); r.i16(14, a.y);
          r.u16(16, d?.w ?? 1); r.u16(18, d?.h ?? 1); r.u16(20, d?.bw ?? 0);
        });
        break; }
      case 15: {                                         // QueryTree
        const w = this.win(u32(4));
        const kids = w ? w.children : [];
        this.reply(conn, 0, 0, kids.length * 4, (r) => {
          let pid = w && w.parent ? (typeof w.parent === 'object' ? w.parent.id : w.parent) : 0;
          if (!pid && w && w !== this.root && this.root.children.includes(w)) pid = this.rootId;
          r.u32(8, this.rootId); r.u32(12, pid); r.u16(16, kids.length);
          kids.forEach((c, i) => r.u32(32 + i * 4, c.id));
        });
        break; }
      case 16: {                                         // InternAtom
        const n = u16(4);
        const a = this.atom(str(8, n), !d1);
        this.reply(conn, 0, 0, 0, (r) => r.u32(8, a));
        break; }
      case 17: {                                         // GetAtomName
        const name = this.atoms[u32(4)] ?? '';
        this.reply(conn, 0, 0, name.length, (r) => {
          r.u16(8, name.length);
          for (let i = 0; i < name.length; i++) r.u8(32 + i, name.charCodeAt(i));
        });
        break; }
      case 18: {                                         // ChangeProperty
        const w = this.win(u32(4)); if (!w) break;
        const prop = u32(8), type = u32(12), fmt = u8(16);
        const n = u32(20), nbytes = n * (fmt / 8);
        const data = req.slice(24, 24 + nbytes);
        const mode = d1, old = w.props.get(prop);
        if (mode === 0 || !old) w.props.set(prop, { type, fmt, data });
        else {
          const m = new Uint8Array(old.data.length + data.length);
          if (mode === 2) { m.set(old.data); m.set(data, old.data.length); }
          else { m.set(data); m.set(old.data, data.length); }
          w.props.set(prop, { type, fmt, data: m });
        }
        break; }
      case 19: { const w = this.win(u32(4)); if (w) w.props.delete(u32(8)); break; }   // DeleteProperty
      case 20: {                                         // GetProperty
        const w = this.win(u32(4)), prop = u32(8);
        const p = w?.props.get(prop);
        if (!p) { this.reply(conn, 0, 0, 0, (r) => { r.u32(8, 0); r.u32(12, 0); r.u32(16, 0); }); break; }
        const unit = p.fmt / 8, off = u32(16) * 4, maxlen = u32(20) * 4;
        const chunk = p.data.subarray(off, off + maxlen);
        if (d1) w.props.delete(prop);
        this.reply(conn, 0, p.fmt, chunk.length, (r) => {
          r.u32(8, p.type); r.u32(12, p.data.length - off - chunk.length);
          r.u32(16, chunk.length / unit);
          r.b.set(chunk, 32);
        });
        break; }
      case 21: {                                         // ListProperties
        const w = this.win(u32(4)); const keys = w ? [...w.props.keys()] : [];
        this.reply(conn, 0, 0, keys.length * 4, (r) => {
          r.u16(8, keys.length); keys.forEach((a, i) => r.u32(32 + i * 4, a));
        });
        break; }
      case 22: this.selOwner = u32(4); break;            // SetSelectionOwner
      case 23: this.reply(conn, 0, 0, 0, (r) => r.u32(8, 0)); break;   // GetSelectionOwner: None
      case 24: {                                         // ConvertSelection -> refuse via SelectionNotify
        const requestor = u32(8);
        const w = this.win(requestor);
        if (w?.conn) { const e = new W(32);
          e.u8(0, 31); e.u16(2, w.conn.seq); e.u32(4, u32(24)); e.u32(8, requestor);
          e.u32(12, u32(12)); e.u32(16, u32(16)); e.u32(20, 0);
          this.event(w.conn, e.b); }
        break; }
      case 25: {                                         // SendEvent
        const dest = u32(4), mask = u32(8);
        const w = this.win(dest === 0 ? 0 : dest);       // PointerWindow/InputFocus unsupported
        if (w?.conn) {
          const e = req.slice(12, 44); e[0] |= 0x80;
          const dv = new DataView(e.buffer); dv.setUint16(2, w.conn.seq, true);
          if (mask === 0 || (w.eventMask & mask)) this.event(w.conn, e);
        }
        break; }
      case 26: {                                         // GrabPointer
        const w = this.win(u32(4));
        if (w) this.grab = { win: w, mask: u16(8), ownerEvents: !!d1, implicit: false };
        if (this.dbgInput) console.error(`<GrabPointer win=0x${u32(4).toString(16)} mask=0x${u16(8).toString(16)} oe=${d1}>`);
        this.reply(conn, 0, 0, 0, () => {});             // status: Success
        break; }
      case 27: if (this.dbgInput) console.error('<UngrabPointer>'); this.grab = null; break;
      case 28: case 29: case 30: break;                  // Grab/UngrabButton, ChangeActivePointerGrab
      case 31: this.reply(conn, 0, 0, 0, () => {}); break;             // GrabKeyboard: Success
      case 32: case 33: case 34: case 35: case 36: case 37: break;     // grabs/AllowEvents/GrabServer
      case 38: {                                         // QueryPointer
        const at = this.windowAt(this.ptr.x, this.ptr.y);
        const w = this.win(u32(4)) ?? this.root;
        const a = this.absPos(w);
        this.reply(conn, 0, 1, 0, (r) => {
          r.u32(8, this.rootId); r.u32(12, at.w === w ? 0 : at.w.id);
          r.i16(16, this.ptr.x); r.i16(18, this.ptr.y);
          r.i16(20, this.ptr.x - a.x); r.i16(22, this.ptr.y - a.y);
          r.u16(24, this.ptr.state);
        });
        break; }
      case 39: this.reply(conn, 0, 0, 0, (r) => r.u32(8, 0)); break;   // GetMotionEvents: none
      case 40: {                                         // TranslateCoordinates
        const src = this.win(u32(4)), dst = this.win(u32(8));
        const sa = src ? this.absPos(src) : { x: 0, y: 0 }, da = dst ? this.absPos(dst) : { x: 0, y: 0 };
        const dx = sa.x + i16(12) - da.x, dy = sa.y + i16(14) - da.y;
        this.reply(conn, 0, 1, 0, (r) => { r.u32(8, 0); r.i16(12, dx); r.i16(14, dy); });
        break; }
      case 41: {                                         // WarpPointer
        const dw = u32(8);
        if (dw) { const w = this.win(dw); const a = w ? this.absPos(w) : { x: 0, y: 0 };
                  this.injectMotion(a.x + i16(20), a.y + i16(22)); }
        else this.injectMotion(this.ptr.x + i16(20), this.ptr.y + i16(22));
        break; }
      case 42: this.focus = u32(4); break;               // SetInputFocus
      case 43: this.reply(conn, 0, 1, 0, (r) => r.u32(8, this.focus)); break;   // GetInputFocus
      case 44: this.reply(conn, 0, 0, 8, (r) => {        // QueryKeymap
          for (const k of this.keysDown) if (k < 256) r.u8(8 + (k >> 3), r.b[8 + (k >> 3)] | (1 << (k & 7)));
        });
        break;
      case 45: {                                         // OpenFont
        const fid = u32(4), n = u16(8);
        const f = this.matchFont(str(12, n));
        this.res.set(fid, { fontObj: f });
        break; }
      case 46: this.res.delete(u32(4)); break;           // CloseFont
      case 47: {                                         // QueryFont (fontable: font or gc)
        const r0 = this.res.get(u32(4));
        const f = r0?.fontObj ?? (r0?.gc ? r0.font : null) ?? this.defaultFont;
        this.queryFontReply(conn, f);
        break; }
      case 48: {                                         // QueryTextExtents
        const r0 = this.res.get(u32(4));
        const f = r0?.fontObj ?? (r0?.gc ? r0.font : null) ?? this.defaultFont;
        const nb = (req.length - 8) / 2 - (d1 ? 1 : 0);  // CHAR2Bs (odd-length flag in d1)
        let s = '';
        for (let i = 0; i < nb; i++) s += String.fromCharCode(req[8 + i * 2 + 1]);
        const tw = f ? f.textWidth(s) : s.length * 6;
        this.reply(conn, 0, 0, 0, (r) => {
          r.i16(8, f?.ascent ?? 11); r.i16(10, f?.descent ?? 2);
          r.i16(12, f?.ascent ?? 11); r.i16(14, f?.descent ?? 2);
          r.i32(16, tw); r.i32(20, 0); r.i32(24, tw);
        });
        break; }
      case 49: {                                         // ListFonts
        const maxn = u16(4), n = u16(6);
        const pat = str(8, n);
        const names = this.listFonts(pat).slice(0, maxn);
        if (XFONTDBG) console.error(`<ListFonts "${pat}" -> ${JSON.stringify(names.slice(0,2))}>`);
        let total = 0; for (const nm of names) total += 1 + nm.length;
        this.reply(conn, 0, 0, total, (r) => {
          r.u16(8, names.length);
          let o = 32;
          for (const nm of names) { r.u8(o++, nm.length); for (const ch of nm) r.u8(o++, ch.charCodeAt(0)); }
        });
        break; }
      case 50: {                                         // ListFontsWithInfo: just the terminator
        this.reply(conn, 0, 0, 28, () => {});
        break; }
      case 51: break;                                    // SetFontPath
      case 52: this.reply(conn, 0, 0, 0, (r) => r.u16(8, 0)); break;   // GetFontPath
      case 53: {                                         // CreatePixmap
        const pid = u32(4);
        const wpx = u16(12), hpx = u16(14);
        this.res.set(pid, { pixmap: true, depth: d1, w: wpx, h: hpx,
                            buffer: new Uint32Array(Math.max(1, wpx * hpx)) });
        break; }
      case 54: this.res.delete(u32(4)); break;           // FreePixmap
      case 55: {                                         // CreateGC
        const gc = { gc: true, id: u32(4), fn: 3, fg: 0, bg: 0xffffff, lw: 0,
                     font: this.defaultFont, fillStyle: 0, clip: null, clipX: 0, clipY: 0,
                     clipMask: null, ge: true, subMode: 0 };
        this.applyGC(gc, u32(12), req, 16, v);
        this.res.set(gc.id, gc);
        break; }
      case 56: {                                         // ChangeGC
        const gc = this.gcOf(u32(4)); if (!gc) break;
        this.applyGC(gc, u32(8), req, 12, v);
        break; }
      case 57: {                                         // CopyGC
        const s0 = this.gcOf(u32(4)), d0 = this.gcOf(u32(8));
        if (s0 && d0) Object.assign(d0, { fn: s0.fn, fg: s0.fg, bg: s0.bg, lw: s0.lw, font: s0.font,
                                          fillStyle: s0.fillStyle, ge: s0.ge });
        break; }
      case 58: break;                                    // SetDashes
      case 59: {                                         // SetClipRectangles
        const gc = this.gcOf(u32(4)); if (!gc) break;
        gc.clipX = i16(8); gc.clipY = i16(10);
        gc.clip = [];
        for (let o = 12; o + 8 <= req.length; o += 8)
          gc.clip.push({ x: i16(o), y: i16(o + 2), w: u16(o + 4), h: u16(o + 6) });
        gc.clipMask = null;
        break; }
      case 60: this.res.delete(u32(4)); break;           // FreeGC
      case 61: {                                         // ClearArea
        const w = this.win(u32(4)); if (!w) break;
        let cw = u16(12) || w.w - i16(8), ch = u16(14) || w.h - i16(10);
        this.rasterFillRect(w, i16(8), i16(10), cw, ch, w.bgPixel, null);
        if (d1) this.expose(w, i16(8), i16(10), cw, ch);
        this.dirty = true; break; }
      case 62: {                                         // CopyArea
        const src = this.drawable(u32(4)), dst = this.drawable(u32(8)), gc = this.gcOf(u32(12));
        if (src && dst) this.copyArea(src, dst, gc, i16(16), i16(18), i16(20), i16(22), u16(24), u16(26));
        if (gc?.ge) { const e = new W(32); e.u8(0, 14); e.u16(2, conn.seq); e.u32(4, u32(8)); e.u8(10, 62); this.event(conn, e.b); }
        this.dirty = true; break; }
      case 63: {                                         // CopyPlane: from depth-1 with fg/bg
        const src = this.drawable(u32(4)), dst = this.drawable(u32(8)), gc = this.gcOf(u32(12));
        if (src && dst && gc) {
          const sx = i16(16), sy = i16(18), dx = i16(20), dy = i16(22), cw = u16(24), chh = u16(26);
          for (let yy = 0; yy < chh; yy++) for (let xx = 0; xx < cw; xx++) {
            const s = src.buffer[(sy + yy) * src.w + (sx + xx)] & 1;
            this.plot(dst, dx + xx, dy + yy, s ? gc.fg : gc.bg, gc);
          }
        }
        if (gc?.ge) { const e = new W(32); e.u8(0, 14); e.u16(2, conn.seq); e.u32(4, u32(8)); e.u8(10, 63); this.event(conn, e.b); }
        this.dirty = true; break; }
      case 64: {                                         // PolyPoint
        const d = this.drawable(u32(4)), gc = this.gcOf(u32(8));
        if (!d || !gc) break;
        let px = 0, py = 0;
        for (let o = 12; o + 4 <= req.length; o += 4) {
          const x = i16(o), y = i16(o + 2);
          if (d1 && o > 12) { px += x; py += y; } else { px = x; py = y; }
          this.plot(d, px, py, gc.fg, gc);
        }
        this.dirty = true; break; }
      case 65: {                                         // PolyLine
        const d = this.drawable(u32(4)), gc = this.gcOf(u32(8));
        if (!d || !gc) break;
        let px = null, py = null;
        for (let o = 12; o + 4 <= req.length; o += 4) {
          let x = i16(o), y = i16(o + 2);
          if (d1 && px !== null) { x += px; y += py; }
          if (px !== null) this.line(d, px, py, x, y, gc);
          px = x; py = y;
        }
        this.dirty = true; break; }
      case 66: {                                         // PolySegment
        const d = this.drawable(u32(4)), gc = this.gcOf(u32(8));
        if (!d || !gc) break;
        for (let o = 12; o + 8 <= req.length; o += 8)
          this.line(d, i16(o), i16(o + 2), i16(o + 4), i16(o + 6), gc);
        this.dirty = true; break; }
      case 67: {                                         // PolyRectangle
        const d = this.drawable(u32(4)), gc = this.gcOf(u32(8));
        if (!d || !gc) break;
        for (let o = 12; o + 8 <= req.length; o += 8) {
          const x = i16(o), y = i16(o + 2), rw = u16(o + 4), rh = u16(o + 6);
          this.line(d, x, y, x + rw, y, gc); this.line(d, x, y + rh, x + rw, y + rh, gc);
          this.line(d, x, y, x, y + rh, gc); this.line(d, x + rw, y, x + rw, y + rh, gc);
        }
        this.dirty = true; break; }
      case 68: {                                         // PolyArc (outline)
        const d = this.drawable(u32(4)), gc = this.gcOf(u32(8));
        if (!d || !gc) break;
        for (let o = 12; o + 12 <= req.length; o += 12)
          this.arc(d, i16(o), i16(o + 2), u16(o + 4), u16(o + 6), i16(o + 8), i16(o + 10), gc, false);
        this.dirty = true; break; }
      case 69: {                                         // FillPoly
        const d = this.drawable(u32(4)), gc = this.gcOf(u32(8));
        if (!d || !gc) break;
        const rel = u8(13) === 1;
        const pts = [];
        let px = 0, py = 0;
        for (let o = 16; o + 4 <= req.length; o += 4) {
          let x = i16(o), y = i16(o + 2);
          if (rel && pts.length) { x += px; y += py; }
          pts.push([x, y]); px = x; py = y;
        }
        this.fillPoly(d, pts, gc);
        this.dirty = true; break; }
      case 70: {                                         // PolyFillRectangle
        const d = this.drawable(u32(4)), gc = this.gcOf(u32(8));
        if (!d || !gc) break;
        for (let o = 12; o + 8 <= req.length; o += 8)
          this.rasterFillRect(d, i16(o), i16(o + 2), u16(o + 4), u16(o + 6), gc.fg, gc);
        this.dirty = true; break; }
      case 71: {                                         // PolyFillArc
        const d = this.drawable(u32(4)), gc = this.gcOf(u32(8));
        if (!d || !gc) break;
        for (let o = 12; o + 12 <= req.length; o += 12)
          this.arc(d, i16(o), i16(o + 2), u16(o + 4), u16(o + 6), i16(o + 8), i16(o + 10), gc, true);
        this.dirty = true; break; }
      case 72: {                                         // PutImage (marks _drawn below)
        const d = this.drawable(u32(4)), gc = this.gcOf(u32(8));
        if (d) d._drawn = true;
        if (!d || !gc) break;
        const wpx = u16(12), hpx = u16(14), dx = i16(16), dy = i16(18);
        const leftPad = u8(20), depth = u8(21);
        if (d1 === 2) {                                  // ZPixmap
          if (depth === 1) {
            const stride = pad4(Math.ceil(wpx / 8));
            for (let yy = 0; yy < hpx; yy++) for (let xx = 0; xx < wpx; xx++) {
              const b = req[24 + yy * stride + (xx >> 3)];
              this.plot(d, dx + xx, dy + yy, (b >> (xx & 7)) & 1, gc);
            }
          } else {
            const stride = wpx * 4;
            for (let yy = 0; yy < hpx; yy++) for (let xx = 0; xx < wpx; xx++) {
              const o = 24 + yy * stride + xx * 4;
              this.plot(d, dx + xx, dy + yy, req[o] | (req[o + 1] << 8) | (req[o + 2] << 16), gc);
            }
          }
        } else {                                         // XYBitmap / XYPixmap (single plane)
          const stride = pad4(Math.ceil((wpx + leftPad) / 8));
          for (let yy = 0; yy < hpx; yy++) for (let xx = 0; xx < wpx; xx++) {
            const bit = xx + leftPad;
            const b = req[24 + yy * stride + (bit >> 3)];
            const set = (b >> (bit & 7)) & 1;
            if (d1 === 0) this.plot(d, dx + xx, dy + yy, set ? gc.fg : gc.bg, gc);
            else if (set) this.plot(d, dx + xx, dy + yy, gc.fg, gc);
          }
        }
        this.dirty = true; break; }
      case 73: {                                         // GetImage
        const d = this.drawable(u32(4));
        const x = i16(8), y = i16(10), wpx = u16(12), hpx = u16(14);
        const out = new Uint8Array(wpx * hpx * 4);
        if (d?.buffer) for (let yy = 0; yy < hpx; yy++) for (let xx = 0; xx < wpx; xx++) {
          const sx = x + xx, sy = y + yy;
          const pix = (sx >= 0 && sy >= 0 && sx < d.w && sy < d.h) ? d.buffer[sy * d.w + sx] : 0;
          const o = (yy * wpx + xx) * 4;
          out[o] = pix & 0xff; out[o + 1] = (pix >> 8) & 0xff; out[o + 2] = (pix >> 16) & 0xff;
        }
        this.reply(conn, 0, d?.depth ?? 24, out.length, (r) => { r.u32(8, 0x22); r.b.set(out, 32); });
        break; }
      case 74: case 75: {                                // PolyText8 / PolyText16
        const d = this.drawable(u32(4)), gc = this.gcOf(u32(8));
        if (!d || !gc) break;
        let x = i16(12); const y = i16(14);
        let o = 16;
        while (req.length - o >= 2) {
          const len = req[o];
          if (len === 0) break;                          // trailing pad
          if (len === 255) {                             // font shift (big-endian font id)
            const fid = (req[o + 1] << 24) | (req[o + 2] << 16) | (req[o + 3] << 8) | req[o + 4];
            const f = this.res.get(fid)?.fontObj; if (f) gc.font = f;
            o += 5; continue;
          }
          const delta = (req[o + 1] << 24 >> 24);
          x += delta;
          let s = '';
          if (op === 74) s = str(o + 2, len);
          else for (let i = 0; i < len; i++) s += String.fromCharCode(req[o + 2 + i * 2 + 1]);
          x = this.drawText(d, x, y, s, gc, false);
          o += 2 + (op === 74 ? len : len * 2);
        }
        this.dirty = true; break; }
      case 76: case 77: {                                // ImageText8 / ImageText16
        const d = this.drawable(u32(4)), gc = this.gcOf(u32(8));
        if (!d || !gc) break;
        let s = '';
        if (op === 76) s = str(16, d1);
        else for (let i = 0; i < d1; i++) s += String.fromCharCode(req[16 + i * 2 + 1]);
        this.drawText(d, i16(12), i16(14), s, gc, true);
        this.dirty = true; break; }
      case 78: case 79: case 80: case 81: case 82: break;   // colormap create/free/copy/install
      case 83: this.reply(conn, 0, 0, 4, (r) => { r.u16(8, 1); r.u32(32, 0x23); }); break;
      case 84: {                                         // AllocColor (TrueColor arithmetic)
        const rr = u16(8), gg = u16(10), bb = u16(12);
        const pix = ((rr >> 8) << 16) | ((gg >> 8) << 8) | (bb >> 8);
        this.reply(conn, 0, 0, 0, (r) => { r.u16(8, rr); r.u16(10, gg); r.u16(12, bb); r.u32(16, pix); });
        break; }
      case 85: {                                         // AllocNamedColor
        const n = u16(8), pix = colorByName(str(12, n));
        const rr = ((pix >> 16) & 0xff) * 257, gg = ((pix >> 8) & 0xff) * 257, bb = (pix & 0xff) * 257;
        this.reply(conn, 0, 0, 0, (r) => {
          r.u32(8, pix); r.u16(12, rr); r.u16(14, gg); r.u16(16, bb);
          r.u16(18, rr); r.u16(20, gg); r.u16(22, bb);
        });
        break; }
      case 86: case 87: this.error(conn, 11, 0, op); break;   // AllocColorCells/Planes: BadAlloc
      case 88: case 89: case 90: break;                  // FreeColors/StoreColors/StoreNamedColor
      case 91: {                                         // QueryColors
        const n = (req.length - 8) / 4;
        this.reply(conn, 0, 0, n * 8, (r) => {
          r.u16(8, n);
          for (let i = 0; i < n; i++) {
            const pix = u32(8 + i * 4);
            r.u16(32 + i * 8, ((pix >> 16) & 0xff) * 257);
            r.u16(34 + i * 8, ((pix >> 8) & 0xff) * 257);
            r.u16(36 + i * 8, (pix & 0xff) * 257);
          }
        });
        break; }
      case 92: {                                         // LookupColor
        const n = u16(8), pix = colorByName(str(12, n));
        const rr = ((pix >> 16) & 0xff) * 257, gg = ((pix >> 8) & 0xff) * 257, bb = (pix & 0xff) * 257;
        this.reply(conn, 0, 0, 0, (r) => {
          r.u16(8, rr); r.u16(10, gg); r.u16(12, bb);
          r.u16(14, rr); r.u16(16, gg); r.u16(18, bb);
        });
        break; }
      case 93: case 94: this.res.set(u32(4), { cursor: true }); break;   // CreateCursor/CreateGlyphCursor
      case 95: case 96: break;                           // FreeCursor/RecolorCursor
      case 97: this.reply(conn, 0, 0, 0, (r) => { r.u16(8, u16(8)); r.u16(10, u16(10)); }); break;   // QueryBestSize
      case 98: this.reply(conn, 0, 0, 0, (r) => { r.u8(8, 0); });    // QueryExtension: absent
        break;
      case 99: this.reply(conn, 0, 0, 0, () => {}); break;             // ListExtensions: none
      case 100: break;                                   // ChangeKeyboardMapping
      case 101: {                                        // GetKeyboardMapping
        const first = u8(4), count = u8(5);
        this.reply(conn, 0, 2, count * 2 * 4, (r) => {
          for (let i = 0; i < count; i++) {
            const ks = KEYMAP[first + i] ?? [0];
            r.u32(32 + i * 8, ks[0] ?? 0);
            r.u32(36 + i * 8, ks[1] ?? ks[0] ?? 0);
          }
        });
        break; }
      case 102: break;                                   // ChangeKeyboardControl
      case 103: this.reply(conn, 0, 1, 20, (r) => { r.u32(8, 0); r.u8(12, 0); r.u8(13, 50); r.u16(14, 400); r.u16(16, 100); }); break;
      case 104: break;                                   // Bell
      case 105: break;                                   // ChangePointerControl
      case 106: this.reply(conn, 0, 0, 0, (r) => { r.u16(8, 2); r.u16(10, 1); r.u16(12, 4); }); break;
      case 107: break;                                   // SetScreenSaver
      case 108: this.reply(conn, 0, 0, 0, (r) => { r.u16(8, 0); r.u16(10, 0); }); break;
      case 109: break;                                   // ChangeHosts
      case 110: this.reply(conn, 0, 0, 0, (r) => r.u16(8, 0)); break;  // ListHosts
      case 111: case 112: case 113: case 114: case 115: break;
      case 116: this.reply(conn, 0, 0, 0, () => {}); break;            // SetPointerMapping: Success
      case 117: this.reply(conn, 0, 5, 8, (r) => { for (let i = 0; i < 5; i++) r.u8(32 + i, i + 1); }); break;
      case 118: this.reply(conn, 0, 0, 0, () => {}); break;            // SetModifierMapping: Success
      case 119: {                                        // GetModifierMapping (2 keycodes per mod)
        const mods = [[50, 62], [66, 0], [37, 105], [64, 108], [0, 0], [0, 0], [0, 0], [0, 0]];
        this.reply(conn, 0, 2, 16, (r) => {
          mods.forEach((m, i) => { r.u8(32 + i * 2, m[0]); r.u8(33 + i * 2, m[1]); });
        });
        break; }
      case 127: break;                                   // NoOperation
      default: this.error(conn, 17, 0, op);              // BadImplementation
    }
  }

  applyWinAttrs(w, mask, req, off, v) {
    const order = ['bgPixmap','bgPixel','borderPixmap','borderPixel','bitGrav','winGrav','backing',
                   'backingPlanes','backingPixel','override','saveUnder','eventMask','dnp','colormap','cursor'];
    let o = off;
    for (let bit = 0; bit < order.length; bit++) {
      if (!(mask & (1 << bit))) continue;
      const val = v.getUint32(o, true); o += 4;
      switch (order[bit]) {
        case 'bgPixel': w.bgPixel = val & 0xffffff; w.bgNone = false; break;
        case 'bgPixmap': w.bgNone = (val === 0); break;
        case 'borderPixel': w.borderPixel = val & 0xffffff; break;
        case 'override': w.override = !!val; break;
        case 'eventMask': w.eventMask = val; break;
        case 'dnp': w.dnp = val; break;
      }
    }
  }
  applyGC(gc, mask, req, off, v) {
    const order = ['fn','planeMask','fg','bg','lw','lineStyle','capStyle','joinStyle','fillStyle','fillRule',
                   'tile','stipple','tsx','tsy','font','subMode','ge','clipX','clipY','clipMask','dashOff','dashes','arcMode'];
    let o = off;
    for (let bit = 0; bit < order.length; bit++) {
      if (!(mask & (1 << bit))) continue;
      const val = v.getUint32(o, true); o += 4;
      switch (order[bit]) {
        case 'fn': gc.fn = val & 15; break;
        case 'fg': gc.fg = val & 0xffffff; break;
        case 'bg': gc.bg = val & 0xffffff; break;
        case 'lw': gc.lw = val; break;
        case 'fillStyle': gc.fillStyle = val; break;
        case 'font': { const f = this.res.get(val)?.fontObj; if (f) gc.font = f; break; }
        case 'ge': gc.ge = !!val; break;
        case 'clipX': gc.clipX = (val << 16) >> 16; break;
        case 'clipY': gc.clipY = (val << 16) >> 16; break;
        case 'clipMask': gc.clipMask = val ? this.res.get(val) : null; if (!val) gc.clip = null; break;
        case 'subMode': gc.subMode = val; break;
      }
    }
  }
  destroyWin(w) {
    const p = this.win(w.parent);
    if (p) p.children = p.children.filter(c => c !== w);
    if (w.conn && (w.eventMask & 0x20000)) {
      const e = new W(32); e.u8(0, 17); e.u16(2, w.conn.seq); e.u32(4, w.id); e.u32(8, w.id);
      this.event(w.conn, e.b);
    }
    for (const c of [...w.children]) this.destroyWin(c);
    this.res.delete(w.id);
  }

  // ---- fonts ---------------------------------------------------------------
  matchFont(pattern) {
    const p = pattern.toLowerCase();
    for (const e of this.fonts) if (e.names.includes(p)) return e.font;
    const rx = new RegExp('^' + p.replace(/[.+^${}()|[\]]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    for (const e of this.fonts) for (const n of e.names) if (rx.test(n)) return e.font;
    // heuristic: pick by pixel size / weight from an XLFD-ish pattern
    const fields = p.split('-');
    const px = Number(fields[7]) || Number(/(\d+)/.exec(p)?.[1]) || 13;
    const bold = p.includes('bold');
    const want = (px >= 14 ? '9x15' : '6x13') + (bold ? 'b' : '');
    for (const e of this.fonts) if (e.names.includes(want)) return e.font;
    return this.defaultFont;
  }
  listFonts(pattern) {
    const rx = new RegExp('^' + pattern.toLowerCase().replace(/[.+^${}()|[\]]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    const out = [];
    // every matching name, not just the first per font: XCreateFontSet asks
    // for an XLFD pattern and needs the XLFD-shaped alias back, and stopping
    // at the first name returned the short one ("builtin5x7") instead —
    // "Unable to load any usable fontset", and Athena apps never paint.
    for (const e of this.fonts) for (const n of e.names) if (rx.test(n)) out.push(n);
    if (!out.length) {
      // XLFD pattern with no concrete match: reflect it back with every
      // wildcard field filled by a plausible default. XCreateFontSet probes
      // one pattern per charset and needs a well-formed parseable name for
      // each; OpenFont on the synthesized name lands on the bitmap font via
      // matchFont's heuristics.
      const parts = pattern.toLowerCase().split('-');
      if (parts.length === 15 && parts[0] === '') {
        const DEF = ['misc', 'fixed', 'medium', 'r', 'normal', '', '13', '120', '75', '75', 'c', '60', 'iso8859', '1'];
        const syn = parts.slice(1).map((f, i) => (f === '*' || f === '?') ? DEF[i] : f);
        out.push('-' + syn.join('-'));
      } else if (this.fonts.length) out.push(this.fonts[0].names[0]);
    }
    return out;
  }
  queryFontReply(conn, f) {
    if (!f) { this.error(conn, 7, 0, 47); return; }
    const lo = Math.max(32, f.minChar), hi = Math.min(255, f.maxChar);
    const n = hi - lo + 1;
    // XCreateFontSet checks a font's CHARSET_REGISTRY/CHARSET_ENCODING
    // properties to decide it covers the locale's charset. Reporting none
    // (as this did) makes every fontset fail — "Unable to load any usable
    // fontset" — so Athena apps start but never paint any text.
    const props = [
      [this.atom('FONT'), this.atom(f._xlfd ?? '-misc-fixed-medium-r-normal--13-120-75-75-c-60-iso8859-1')],
      [this.atom('CHARSET_REGISTRY'), this.atom('ISO8859')],
      [this.atom('CHARSET_ENCODING'), this.atom('1')],
      [this.atom('PIXEL_SIZE'), f.ascent + f.descent],
      [this.atom('POINT_SIZE'), (f.ascent + f.descent) * 10],
      [this.atom('RESOLUTION_X'), 75], [this.atom('RESOLUTION_Y'), 75],
      [this.atom('SPACING'), this.atom('C')],
      [this.atom('WEIGHT_NAME'), this.atom('medium')],
      [this.atom('SLANT'), this.atom('R')],
      [this.atom('FOUNDRY'), this.atom('misc')],
      [this.atom('FAMILY_NAME'), this.atom('fixed')],
    ];
    const PB = 60, CB = PB + props.length * 8;              // props, then char infos
    this.reply(conn, 0, 0, (CB - 32) + n * 12, (r) => {
      const put = (o, m) => { r.i16(o, m.lsb); r.i16(o + 2, m.rsb); r.i16(o + 4, m.width);
                              r.i16(o + 6, m.ascent); r.i16(o + 8, m.descent); r.u16(o + 10, 0); };
      put(8, f.minBounds);
      put(24, f.maxBounds);
      r.u16(40, lo); r.u16(42, hi); r.u16(44, f.defaultChar);
      r.u16(46, props.length); r.u8(48, 0); r.u8(49, 0); r.u8(50, 0); r.u8(51, 1);
      r.i16(52, f.ascent); r.i16(54, f.descent); r.u32(56, n);
      props.forEach(([a, v], i) => { r.u32(PB + i * 8, a); r.u32(PB + i * 8 + 4, v); });
      for (let i = 0; i < n; i++) {
        const g = f.glyph(lo + i) ?? { lsb: 0, rsb: 0, width: 0, ascent: 0, descent: 0 };
        put(CB + i * 12, g);
      }
    });
  }

  // ---- rasterizer ----------------------------------------------------------
  clipOK(gc, x, y) {
    if (!gc) return true;
    if (gc.clip) {
      let ok = false;
      for (const r of gc.clip)
        if (x >= r.x + gc.clipX && x < r.x + gc.clipX + r.w && y >= r.y + gc.clipY && y < r.y + gc.clipY + r.h) { ok = true; break; }
      if (!ok) return false;
    }
    if (gc.clipMask?.buffer) {
      const mx = x - gc.clipX, my = y - gc.clipY;
      if (mx < 0 || my < 0 || mx >= gc.clipMask.w || my >= gc.clipMask.h) return false;
      if (!(gc.clipMask.buffer[my * gc.clipMask.w + mx] & 1)) return false;
    }
    return true;
  }
  plot(d, x, y, pix, gc) {
    if (x < 0 || y < 0 || x >= d.w || y >= d.h || !d.buffer) return;
    d._drawn = true;
    if (!this.clipOK(gc, x, y)) return;
    const i = y * d.w + x, dst = d.buffer[i], s = pix, m = 0xffffff;
    const fn = gc ? gc.fn : 3;
    let out;
    switch (fn) {
      case 0: out = 0; break;              case 1: out = s & dst; break;
      case 2: out = s & ~dst; break;       case 3: out = s; break;
      case 4: out = ~s & dst; break;       case 5: out = dst; break;
      case 6: out = s ^ dst; break;        case 7: out = s | dst; break;
      case 8: out = ~(s | dst); break;     case 9: out = ~(s ^ dst); break;
      case 10: out = ~dst; break;          case 11: out = s | ~dst; break;
      case 12: out = ~s; break;            case 13: out = ~s | dst; break;
      case 14: out = ~(s & dst); break;    default: out = m;
    }
    d.buffer[i] = out & m;
  }
  rasterFillRect(d, x, y, w, h, pix, gc) {
    d._drawn = true;
    const x0 = Math.max(0, x), y0 = Math.max(0, y);
    const x1 = Math.min(d.w, x + w), y1 = Math.min(d.h, y + h);
    if (!d.buffer) return;
    if ((!gc || (gc.fn === 3 && !gc.clip && !gc.clipMask))) {
      for (let yy = y0; yy < y1; yy++) d.buffer.fill(pix & 0xffffff, yy * d.w + x0, yy * d.w + x1);
    } else {
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.plot(d, xx, yy, pix, gc);
    }
  }
  line(d, x0, y0, x1, y1, gc) {
    let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      this.plot(d, x0, y0, gc.fg, gc);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }
  fillPoly(d, pts, gc) {
    if (pts.length < 3) return;
    let ymin = Infinity, ymax = -Infinity;
    for (const [, y] of pts) { ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
    for (let y = Math.max(0, ymin); y <= Math.min(d.h - 1, ymax); y++) {
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
        if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y))
          xs.push(x0 + (y - y0) / (y1 - y0) * (x1 - x0));
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2)
        for (let x = Math.max(0, Math.ceil(xs[i])); x < Math.min(d.w, Math.ceil(xs[i + 1])); x++)
          this.plot(d, x, y, gc.fg, gc);
    }
  }
  arc(d, x, y, w, h, a1, a2, gc, fill) {
    const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
    const full = Math.abs(a2) >= 360 * 64;
    const s = a1 / 64 * Math.PI / 180, e = (a1 + a2) / 64 * Math.PI / 180;
    const inAngle = (px, py) => {
      if (full) return true;
      let t = Math.atan2(-(py - cy) / (ry || 1), (px - cx) / (rx || 1));
      const lo = Math.min(s, e), hi = Math.max(s, e);
      while (t < lo) t += 2 * Math.PI;
      return t <= hi;
    };
    if (fill) {
      for (let yy = Math.max(0, y); yy < Math.min(d.h, y + h); yy++)
        for (let xx = Math.max(0, x); xx < Math.min(d.w, x + w); xx++) {
          const nx = (xx + 0.5 - cx) / (rx || 1), ny = (yy + 0.5 - cy) / (ry || 1);
          if (nx * nx + ny * ny <= 1 && inAngle(xx + 0.5, yy + 0.5)) this.plot(d, xx, yy, gc.fg, gc);
        }
    } else {
      const steps = Math.max(16, Math.ceil((rx + ry) * 2));
      const from = full ? 0 : s, to = full ? 2 * Math.PI : e;
      let px = null, py = null;
      for (let i = 0; i <= steps; i++) {
        const t = from + (to - from) * i / steps;
        const xx = Math.round(cx + rx * Math.cos(t)), yy = Math.round(cy - ry * Math.sin(t));
        if (px !== null) this.line(d, px, py, xx, yy, gc);
        px = xx; py = yy;
      }
    }
  }
  drawText(d, x, y, s, gc, image) {
    const f = gc.font ?? this.defaultFont;
    if (!f) return x;
    if (image) {
      const tw = f.textWidth(s);
      this.rasterFillRect(d, x, y - f.ascent, tw, f.ascent + f.descent, gc.bg, null);
    }
    for (let i = 0; i < s.length; i++) {
      const g = f.glyph(s.charCodeAt(i));
      if (!g) continue;
      for (let r = 0; r < g.rows.length; r++) {
        const row = g.rows[r];
        for (let c = 0; c < row.length; c++)
          if (row[c]) this.plot(d, x + g.lsb + c, y - g.ascent + r, gc.fg, gc);
      }
      x += g.width;
    }
    return x;
  }
  copyArea(src, dst, gc, sx, sy, dx, dy, w, h) {
    // Fast path: plain GXcopy with no clip list and no clip mask is a pure
    // rectangle move, so it is row-wise subarray/set instead of w*h calls
    // through plot(). A browser stroke profile put copyArea at 10.8% of a
    // drag's busy time — GIMP blits its canvas through this constantly.
    // Anything else (raster ops, clipping) keeps the per-pixel path, which
    // is what makes the fast path safe to add rather than a rewrite.
    // The fast path must reproduce THIS implementation's behaviour, not X's
    // spec: the per-pixel path writes 0 into the destination wherever the
    // source rect falls outside the source surface. Rather than reproduce
    // that, take the fast path only when both rects are fully in bounds —
    // which is the case GIMP's canvas blits actually hit. A differential
    // test against the per-pixel path caught this: clamping instead of
    // restricting mismatched on 145 of 300 random rects.
    const plain = (!gc || (gc.fn === 3 && !gc.clip && !gc.clipMask?.buffer));
    const inBounds = src.buffer && dst.buffer &&
      sx >= 0 && sy >= 0 && sx + w <= src.w && sy + h <= src.h &&
      dx >= 0 && dy >= 0 && dx + w <= dst.w && dy + h <= dst.h;
    if (plain && inBounds) {
      const cw = w, ch = h;
      if (cw > 0 && ch > 0) {
        dst._drawn = true;
        const sxa = sx, sya = sy, dxa = dx, dya = dy;
        // set(subarray) and not copyWithin: the usual case is a copy BETWEEN
        // surfaces (pixmap -> window), where copyWithin would read the wrong
        // buffer entirely. set() also has memmove semantics when source and
        // destination share a buffer, so a self-overlapping scroll is safe.
        for (let yy = 0; yy < ch; yy++) {
          const so = (sya + yy) * src.w + sxa, dof = (dya + yy) * dst.w + dxa;
          dst.buffer.set(src.buffer.subarray(so, so + cw), dof);
        }
      }
      return;
    }
    const tmp = new Uint32Array(w * h);
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const x0 = sx + xx, y0 = sy + yy;
      tmp[yy * w + xx] = (x0 >= 0 && y0 >= 0 && x0 < src.w && y0 < src.h && src.buffer)
        ? src.buffer[y0 * src.w + x0] : 0;
    }
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++)
      this.plot(dst, dx + xx, dy + yy, tmp[yy * w + xx], gc);
  }
}

function concat(a, b) {
  const m = new Uint8Array(a.length + b.length);
  m.set(a); m.set(b, a.length);
  return m;
}

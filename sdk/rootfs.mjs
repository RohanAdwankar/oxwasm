// A sandbox whose filesystem is a Linux root tarball (an Ubuntu base image
// with Python, apt and CA certificates), instead of files borrowed from the
// host. The guest then has the same userland on every machine - Linux, macOS
// or Windows - and `apt install` has a real dpkg database to work against.
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const dec = new TextDecoder();
const str = (b, o, n) => { let e = o; const end = o + n; while (e < end && b[e] !== 0) e++; return dec.decode(b.subarray(o, e)); };
const oct = (b, o, n) => parseInt(str(b, o, n).trim() || '0', 8);

/** Parse a (gzipped) tar into the maps the engine's filesystem wants. */
export function parseTar(buf) {
  const files = {}, mtimes = {}, links = new Map(), dirs = new Set(), modes = new Map(), hard = [];
  let longName = null, paxPath = null;
  for (let o = 0; o + 512 <= buf.length;) {
    if (buf[o] === 0) { o += 512; if (buf[o] === 0) break; continue; }
    const h = o;
    const type = String.fromCharCode(buf[o + 156] || 48);
    const size = oct(buf, o + 124, 12);
    let name = str(buf, o, 100);
    const prefix = str(buf, o + 345, 155);
    if (prefix) name = prefix + '/' + name;
    const data = buf.subarray(o + 512, o + 512 + size);
    o += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = str(data, 0, data.length); continue; }
    if (type === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(dec.decode(data)); if (m) paxPath = m[1]; continue;
    }
    if (type === 'g') continue;
    if (longName) { name = longName; longName = null; }
    if (paxPath) { name = paxPath; paxPath = null; }
    let p = '/' + name.replace(/^\.?\/+/, '').replace(/\/+$/, '');
    if (p === '/' || p === '/.') continue;
    const mode = oct(buf, h + 100, 8) & 0o7777;
    const mtime = oct(buf, h + 136, 12);
    if (type === '5') { dirs.add(p); continue; }
    if (type === '2') { links.set(p, str(buf, h + 157, 100)); continue; }
    if (type === '1') { hard.push([p, '/' + str(buf, h + 157, 100).replace(/^\.?\/+/, '')]); continue; }
    if (type === '0' || type === '7') { files[p] = data; mtimes[p] = mtime; modes.set(p, mode); }
  }
  for (const [p, target] of hard) if (files[target]) { files[p] = files[target]; mtimes[p] = mtimes[target]; modes.set(p, modes.get(target)); }
  return { files, mtimes, links, dirs, modes };
}

/** Resolve symlinks in `path` through the link table. */
export function resolveIn(img, path, depth = 0) {
  if (depth > 16) return path;
  const parts = path.split('/').filter(Boolean);
  let cur = '';
  for (let i = 0; i < parts.length; i++) {
    cur += '/' + parts[i];
    const t = img.links.get(cur);
    if (t !== undefined) {
      const base = t.startsWith('/') ? t : cur.slice(0, cur.lastIndexOf('/')) + '/' + t;
      const norm = []; for (const s of base.split('/')) { if (s === '..') norm.pop(); else if (s && s !== '.') norm.push(s); }
      return resolveIn(img, '/' + norm.concat(parts.slice(i + 1)).join('/'), depth + 1);
    }
  }
  return path;
}

export function loadRootfs(path) {
  if (!existsSync(path)) throw new Error(`rootfs image not found: ${path}`);
  const raw = readFileSync(path);
  const tar = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  const img = parseTar(new Uint8Array(tar.buffer, tar.byteOffset, tar.length));
  return img;
}

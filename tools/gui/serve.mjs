// Static server for xpack --sidecar output.
//   node serve.mjs DIR [port] [throttleMbps]
// A request for /foo is served from DIR/foo.br with Content-Encoding: br when
// that file exists (sidecars are stored pre-compressed at pack time; the
// browser decodes natively while streaming). Everything else is served plain,
// gzipped on the fly when the client accepts it. Long max-age makes repeat
// visits hit the browser's HTTP cache.
//
// throttleMbps > 0 paces ALL responses through one shared token bucket — a
// real N-Mbps link simulated at the socket, with none of the throughput caps
// Chrome's DevTools network emulation exhibits for large downloads.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { gzipSync } from 'node:zlib';

const [dir, port = '8080', mbpsS = '0'] = process.argv.slice(2);
if (!dir) { console.error('usage: serve.mjs DIR [port] [throttleMbps]'); process.exit(1); }
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript' };

const bps = +mbpsS * 125000;                     // Mbit/s -> bytes/s
let tokens = 0, lastRefill = Date.now();
const take = (want) => {
  const now = Date.now();
  tokens = Math.min(bps / 20, tokens + bps * (now - lastRefill) / 1000);  // ≤50ms burst
  lastRefill = now;
  const n = Math.min(want, Math.floor(tokens));
  tokens -= n; return n;
};
const send = (res, code, headers, buf) => {
  res.writeHead(code, { ...headers, 'content-length': buf.length });
  if (!bps) { res.end(buf); return; }
  const CH = Math.max(16384, Math.floor(bps / 100));
  let off = 0;
  const tick = () => {
    if (res.destroyed) return;
    const n = take(Math.min(CH, buf.length - off));
    if (n > 0) { res.write(buf.subarray(off, off + n)); off += n; }
    if (off < buf.length) setTimeout(tick, 4); else res.end();
  };
  tick();
};

createServer((req, res) => {
  let p = req.url.split('?')[0];
  console.log(new Date().toISOString(), req.method, p, req.headers['if-none-match'] ?? req.headers['if-modified-since'] ?? '');
  if (p === '/') p = '/index.html';
  const fp = join(dir, normalize(p).replace(/^(\.\.[/\\])+/, ''));
  const common = { 'cache-control': 'public, max-age=86400' };
  if (existsSync(fp + '.br')) {
    send(res, 200, { ...common, 'content-encoding': 'br',
      'content-type': 'application/octet-stream' }, readFileSync(fp + '.br'));
  } else if (existsSync(fp)) {
    let b = readFileSync(fp);
    const h = { ...common, 'content-type': TYPES[extname(fp)] ?? 'application/octet-stream' };
    if ((req.headers['accept-encoding'] ?? '').includes('gzip')) {
      b = gzipSync(b, { level: 6 }); h['content-encoding'] = 'gzip';
    }
    send(res, 200, h, b);
  } else { res.writeHead(404); res.end('not found'); }
}).listen(+port, () => console.log(`serving ${dir} on http://127.0.0.1:${port}/${bps ? ` at ${mbpsS} Mbps` : ''}`));

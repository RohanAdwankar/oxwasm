// Static server for xpack --sidecar output.
//   node serve.mjs DIR [port]
// A request for /foo is served from DIR/foo.br with Content-Encoding: br when
// that file exists (sidecars are stored pre-compressed at pack time; the
// browser decodes natively while streaming). Everything else is served plain,
// gzipped on the fly when the client accepts it. Long max-age makes repeat
// visits hit the browser's HTTP cache.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { gzipSync } from 'node:zlib';

const [dir, port = '8080'] = process.argv.slice(2);
if (!dir) { console.error('usage: serve.mjs DIR [port]'); process.exit(1); }
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript' };

createServer((req, res) => {
  let p = req.url.split('?')[0];
  console.log(new Date().toISOString(), req.method, p, req.headers['if-none-match'] ?? req.headers['if-modified-since'] ?? '');
  if (p === '/') p = '/index.html';
  const fp = join(dir, normalize(p).replace(/^(\.\.[/\\])+/, ''));
  const common = { 'cache-control': 'public, max-age=86400' };
  if (existsSync(fp + '.br')) {
    const b = readFileSync(fp + '.br');
    res.writeHead(200, { ...common, 'content-encoding': 'br',
      'content-type': 'application/octet-stream', 'content-length': b.length });
    res.end(b);
  } else if (existsSync(fp)) {
    let b = readFileSync(fp);
    const h = { ...common, 'content-type': TYPES[extname(fp)] ?? 'application/octet-stream' };
    if ((req.headers['accept-encoding'] ?? '').includes('gzip')) {
      b = gzipSync(b, { level: 6 }); h['content-encoding'] = 'gzip';
    }
    h['content-length'] = b.length;
    res.writeHead(200, h); res.end(b);
  } else { res.writeHead(404); res.end('not found'); }
}).listen(+port, () => console.log(`serving ${dir} on http://127.0.0.1:${port}/`));

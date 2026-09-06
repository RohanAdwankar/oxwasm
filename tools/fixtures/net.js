// net.js - node's net and dgram modules over the loopback: a TCP echo server
// and client in one process (libuv: nonblocking connect, epoll, backpressure
// on 2 MB), a server that closes first (EOF on the client), a refused
// connect, a UDP exchange, then a unix-domain server on a path
const net = require('net'), dgram = require('dgram'), os = require('os'), fs = require('fs'), path = require('path');
const out = [];
const log = (...a) => out.push(a.join(' '));
const srv = net.createServer((c) => { c.pipe(c); });
srv.listen(0, '127.0.0.1', () => {
  const port = srv.address().port; log('listening', port > 1024, srv.address().family);
  const big = Buffer.alloc(2 * 1024 * 1024, 0x61);
  const cl = net.connect(port, '127.0.0.1', () => {
    log('connected', cl.localAddress, cl.remotePort === port);
    cl.setNoDelay(true); cl.write(big); cl.end();
  });
  let got = 0, chunks = 0;
  cl.on('data', (d) => { got += d.length; chunks++; });
  cl.on('end', () => { log('echoed', got, got === big.length, chunks > 1); cl.destroy(); step2(port); });
  cl.on('error', (e) => log('client error', e.code));
});
function step2(port) {
  // a server that closes first: the client sees EOF, then a refused port
  srv.close(() => {
    const s2 = net.createServer((c) => { c.write('bye'); c.end(); });
    s2.listen(0, '127.0.0.1', () => {
      const c = net.connect(s2.address().port, '127.0.0.1');
      let d = '';
      c.on('data', (x) => d += x); c.on('end', () => { log('eof after', JSON.stringify(d)); c.destroy(); s2.close(() => step3(port)); });
    });
  });
}
function step3(port) {
  const c = net.connect(port, '127.0.0.1');
  c.on('error', (e) => { log('refused', e.code); step4(); });
  c.on('connect', () => { log('connected to a closed port?'); step4(); });
}
function step4() {
  const a = dgram.createSocket('udp4'), b = dgram.createSocket('udp4');
  b.bind(0, '127.0.0.1', () => {
    b.on('message', (m, r) => { log('udp', m.toString(), r.address, r.port > 1024); a.close(); b.close(); step5(); });
    a.send(Buffer.from('ping'), b.address().port, '127.0.0.1');
  });
}
function step5() {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nu')), 'sock');
  const us = net.createServer((c) => { c.end('unix hi'); });
  us.listen(p, () => {
    log('unix node', fs.statSync(p).isSocket());
    const c = net.connect(p); let d = '';
    c.on('data', (x) => d += x); c.on('end', () => { log('unix got', d); c.destroy(); us.close(() => { fs.rmSync(path.dirname(p), { recursive: true }); finish(); }); });
  });
}
function finish() { log('done'); process.stdout.write(out.join('\n') + '\n'); }

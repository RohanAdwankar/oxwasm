// The host side of the guest's network: real TCP and UDP sockets behind the
// engine's socket syscalls. The guest never sees the host's interfaces - it
// gets a stream and a datagram bridge to addresses the policy allows.
//
// Policy, because a sandbox with a network is a way into whatever the host
// can reach: by default only public addresses are allowed. Private,
// link-local (cloud metadata lives there) and carrier-grade ranges are
// refused unless `allowPrivate` is set; `deny` and `allow` refine either way.
import net from 'node:net';
import dgram from 'node:dgram';
import { readFileSync } from 'node:fs';

const ERRNO = { ECONNREFUSED: 111, ETIMEDOUT: 110, ENETUNREACH: 101, EHOSTUNREACH: 113, ECONNRESET: 104, EACCES: 13, EADDRNOTAVAIL: 99 };

const ip4 = (s) => s.split('.').reduce((a, x) => (a << 8n) | BigInt(+x), 0n);
const inCidr = (ip, cidr) => {
  const [base, bits = '32'] = cidr.split('/');
  const n = BigInt(bits), mask = n === 0n ? 0n : ((1n << 32n) - 1n) ^ ((1n << (32n - n)) - 1n);
  return (ip4(ip) & mask) === (ip4(base) & mask);
};
const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10', '127.0.0.0/8', '0.0.0.0/8', '224.0.0.0/3'];

/** Nameservers the host uses, as the guest's resolv.conf should list them. */
export function hostResolvers() {
  try {
    const out = [...readFileSync('/etc/resolv.conf', 'utf8').matchAll(/^\s*nameserver\s+(\d+\.\d+\.\d+\.\d+)/gm)].map((m) => m[1]);
    if (out.length) return out;
  } catch {}
  return ['1.1.1.1', '8.8.8.8'];
}

export function makeNet(opts = {}) {
  const o = opts === true ? {} : opts;
  const resolvers = new Set(o.resolvers ?? hostResolvers());
  const allowed = (ip, port, proto) => {
    if (proto === 'udp' && port === 53 && resolvers.has(ip)) return true;   // name resolution always works
    if (o.deny?.some((c) => inCidr(ip, c.includes('/') ? c : c + '/32'))) return false;
    if (o.allow?.some((c) => inCidr(ip, c.includes('/') ? c : c + '/32'))) return true;
    if (!o.allowPrivate && PRIVATE.some((c) => inCidr(ip, c))) return false;
    return true;
  };

  return {
    localIp: '10.0.2.15',
    resolvers: [...resolvers],
    tcp(ip, port) {
      const conn = { state: 'connecting', err: 0, rx: [], eof: false, write() {}, end() {}, destroy() {} };
      if (!allowed(ip, port, 'tcp')) { conn.state = 'error'; conn.err = ERRNO.ENETUNREACH; return conn; }
      const sock = net.connect({ host: ip, port });
      sock.setNoDelay(true);
      sock.on('connect', () => { conn.state = 'open'; });
      sock.on('data', (b) => conn.rx.push(new Uint8Array(b)));
      sock.on('end', () => { conn.eof = true; });
      sock.on('close', () => { conn.eof = true; if (conn.state === 'connecting') { conn.state = 'error'; conn.err = ERRNO.ECONNREFUSED; } });
      sock.on('error', (e) => { if (conn.state === 'connecting') { conn.state = 'error'; conn.err = ERRNO[e.code] ?? ERRNO.ECONNREFUSED; } else conn.eof = true; });
      sock.setTimeout(0);
      const t = setTimeout(() => { if (conn.state === 'connecting') { conn.state = 'error'; conn.err = ERRNO.ETIMEDOUT; sock.destroy(); } }, o.connectTimeoutMs ?? 30000);
      t.unref?.();
      conn.write = (b) => { if (!sock.destroyed) sock.write(Buffer.from(b)); };
      conn.end = () => { if (!sock.destroyed) sock.end(); };
      conn.destroy = () => sock.destroy();
      return conn;
    },
    udp() {
      const s = { queue: [], send() {}, close() {} };
      const sock = dgram.createSocket('udp4');
      sock.on('message', (b, r) => s.queue.push({ bytes: new Uint8Array(b), ip: r.address, port: r.port }));
      sock.on('error', () => {});
      s.send = (bytes, ip, port) => { if (allowed(ip, port, 'udp')) sock.send(Buffer.from(bytes), port, ip, () => {}); };
      s.close = () => { try { sock.close(); } catch {} };
      sock.unref?.();
      return s;
    },
    closeAll() {},
  };
}

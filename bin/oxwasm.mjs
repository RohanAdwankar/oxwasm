#!/usr/bin/env node
// oxwasm shell [--rootfs image.tar.gz] [--no-network] [--ca bundle.pem] [--mem MB]
//
// A login shell inside a fresh sandbox, on your terminal.
import { Sandbox } from '../sdk/index.mjs';

const args = process.argv.slice(2);
const cmd = args.shift();
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; const [, v] = args.splice(i, args[i + 1]?.startsWith('--') || args[i + 1] === undefined ? 1 : 2); return v ?? true; };

if (cmd !== 'shell') {
  console.error('usage: oxwasm shell [--rootfs image.tar.gz] [--no-network] [--ca bundle.pem] [--mem MB]');
  process.exit(cmd === '--help' || cmd === undefined ? 0 : 2);
}

const rootfs = flag('--rootfs') || process.env.OXWASM_ROOTFS;
const noNet = flag('--no-network');
const ca = flag('--ca');
const mem = Number(flag('--mem')) || (rootfs ? 1024 : 512);
const stderr = (s) => process.stderr.write(s);

stderr('starting sandbox...\r\n');
const sbx = await Sandbox.create({
  rootfs, memMB: mem, timeoutMs: 24 * 3600 * 1000,
  network: noNet ? false : (ca ? { caBundle: ca } : true),
});
const size = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
const pty = await sbx.pty.create({ ...size(), onData: (b) => process.stdout.write(b) });

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', (b) => { pty.sendInput(b).catch(() => {}); });
process.stdout.on('resize', () => { pty.resize(size()).catch(() => {}); });

const { exitCode } = await pty.wait();
if (process.stdin.isTTY) process.stdin.setRawMode(false);
await sbx.close();
process.exit(exitCode ?? 0);

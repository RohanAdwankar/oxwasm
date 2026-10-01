// The sandbox SDK: state that persists, a guest that cannot reach the host, and
// a runaway cell that cannot take the host down. Skips on a machine with no
// python3.
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import {
  Sandbox, Execution, TimeoutError, CommandExitError, FileNotFoundError, SandboxNotFoundError,
  NotSupportedError, SandboxError,
} from '../../sdk/index.mjs';

if (!existsSync('/usr/bin/python3')) { console.log('sandboxtest SKIPPED: no /usr/bin/python3 on this host'); process.exit(0); }

let pass = 0, fail = 0;
const VERBOSE = !!process.env.SBT_VERBOSE;          // SBT_VERBOSE=1: name each check as it passes, to find the one that faults
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; if (VERBOSE) console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};
const yes = (name, v) => is(name, !!v, true);
const rejects = async (name, p, cls) => {
  try { await p; fail++; console.log(`FAIL ${name}: did not throw`); }
  catch (e) { yes(`${name} (${e?.name})`, e instanceof cls); }
};

let sbx;
try { sbx = await Sandbox.create(); }
catch (e) { console.log(`sandboxtest SKIPPED: ${e.message}`); process.exit(0); }

// ---- execution semantics ----------------------------------------------------
yes('runCode returns an Execution', (await sbx.runCode('x = 10')) instanceof Execution);
const pr = await sbx.runCode('print(x * 5)');
is('print goes to logs.stdout, a line at a time', pr.logs.stdout, ['50\n']);
is('...and is NOT the main result: execution.text is undefined', pr.text, undefined);
const ex = await sbx.runCode('x += 1; x');
is('the last expression is the main result', ex.text, '11');
is('the main result is flagged', ex.results[0].isMainResult, true);
is('executionCount increments', (await sbx.runCode('1')).executionCount > ex.executionCount, true);
is('a def and a call in one cell', (await sbx.runCode('def f(n):\n    return n * 3\nf(7)')).text, '21');

const rich = await sbx.runCode('class R:\n    def _repr_html_(self): return "<b>hi</b>"\nR()');
is('rich results carry html', rich.results[0].html, '<b>hi</b>');
is('formats() lists it', rich.results[0].formats(), ['html']);

const seen = { out: [], err: [], res: 0, errs: 0 };
await sbx.runCode('import sys\nprint("a")\nprint("b", file=sys.stderr)\n42', {
  onStdout: (m) => seen.out.push(m.line), onStderr: (m) => seen.err.push(m.line),
  onResult: () => seen.res++, onError: () => seen.errs++,
});
is('onStdout streams lines', seen.out, ['a\n']);
is('onStderr streams lines', seen.err, ['b\n']);
is('onResult fires', seen.res, 1);

const boom = await sbx.runCode('1/0');
is('an error is on execution.error, not thrown', boom.error?.name, 'ZeroDivisionError');
is('error.value', boom.error?.value, 'division by zero');
yes('error.traceback names the cell', /line 1, in <module>/.test(boom.error?.traceback || ''));
is('no driver frames in the traceback', /guest\.py/.test(boom.error?.traceback || ''), false);
is('a syntax error is an error too', (await sbx.runCode('def (')).error?.name, 'SyntaxError');
is('state survives an error', (await sbx.runCode('x')).text, '11');

// ---- code contexts ----------------------------------------------------------
const c1 = await sbx.createCodeContext();
await sbx.runCode('y = "in c1"', { context: c1 });
is('a context has its own globals', (await sbx.runCode('y', { context: c1 })).text, "'in c1'");
is('...invisible from the default one', (await sbx.runCode('y')).error?.name, 'NameError');
is('listCodeContexts', (await sbx.listCodeContexts()).some((c) => c.id === c1.id), true);
await sbx.restartCodeContext(c1);
is('restart clears a context', (await sbx.runCode('y', { context: c1 })).error?.name, 'NameError');
await sbx.removeCodeContext(c1);
is('a removed context is gone', (await sbx.listCodeContexts()).some((c) => c.id === c1.id), false);

// ---- envs ---------------------------------------------------------------------
is('runCode envs', (await sbx.runCode('import os; os.environ["OX_T"]', { envs: { OX_T: 'v' } })).text, "'v'");
is('...do not leak past the call', (await sbx.runCode('import os; os.environ.get("OX_T")')).text, undefined);

// ---- files ----------------------------------------------------------------------
const w = await sbx.files.write('/work/dir/a.txt', 'hello');
is('write returns WriteInfo', [w.name, w.type, w.path], ['a.txt', 'file', '/work/dir/a.txt']);
is('read (text)', await sbx.files.read('/work/dir/a.txt'), 'hello');
await sbx.files.write('/work/b.bin', new Uint8Array([0, 1, 2, 250, 255]));
is('bytes round-trip', Array.from(await sbx.files.read('/work/b.bin', { format: 'bytes' })), [0, 1, 2, 250, 255]);
is('exists', [await sbx.files.exists('/work/b.bin'), await sbx.files.exists('/work/nope')], [true, false]);
is('makeDir creates, then reports it existed', [await sbx.files.makeDir('/work/new'), await sbx.files.makeDir('/work/new')], [true, false]);
is('list', (await sbx.files.list('/work')).map((e) => `${e.name}:${e.type}`).sort(), ['b.bin:file', 'dir:dir', 'new:dir']);
is('list depth', (await sbx.files.list('/work', { depth: 2 })).map((e) => e.name).sort(), ['a.txt', 'b.bin', 'dir', 'new']);
const inf = await sbx.files.getInfo('/work/dir/a.txt');
is('getInfo', [inf.size, inf.type, inf.modifiedTime instanceof Date], [5, 'file', true]);
await sbx.files.rename('/work/dir/a.txt', '/work/dir/c.txt');
is('rename', [await sbx.files.exists('/work/dir/a.txt'), await sbx.files.exists('/work/dir/c.txt')], [false, true]);
await sbx.files.remove('/work/dir');
is('remove a directory tree', await sbx.files.exists('/work/dir/c.txt'), false);
await rejects('reading a missing file', sbx.files.read('/work/nope'), FileNotFoundError);
await sbx.runCode('open("/work/py.txt","w").write("from python")');
is('files written by code are visible to files.read', await sbx.files.read('/work/py.txt'), 'from python');
await sbx.files.write([{ path: '/work/m1', data: '1' }, { path: '/work/m2', data: '2' }]);
is('write many', [await sbx.files.read('/work/m1'), await sbx.files.read('/work/m2')], ['1', '2']);

// ---- commands ---------------------------------------------------------------------
const echo = await sbx.commands.run('echo hello; echo oops >&2');
is('commands.run', [echo.exitCode, echo.stdout, echo.stderr], [0, 'hello\n', 'oops\n']);
try { await sbx.commands.run('echo partial; exit 3'); is('nonzero exit throws', true, false); }
catch (e) { yes('nonzero exit throws CommandExitError', e instanceof CommandExitError); is('...with exitCode/stdout', [e.exitCode, e.stdout], [3, 'partial\n']); }
is('cwd', (await sbx.commands.run('pwd', { cwd: '/work' })).stdout, '/work\n');
is('envs', (await sbx.commands.run('echo $OX_C', { envs: { OX_C: 'set' } })).stdout, 'set\n');
is('a pipeline', (await sbx.commands.run('printf "b\\na\\nc\\n" | sort | head -2')).stdout, 'a\nb\n');
const streamed = []; await sbx.commands.run('echo one; echo two', { onStdout: (d) => streamed.push(d) });
is('onStdout streams', streamed.join(''), 'one\ntwo\n');
await sbx.commands.run('echo shared > /work/sh.txt');
is('python sees what a command wrote', (await sbx.runCode('open("/work/sh.txt").read()')).text, "'shared\\n'");
const bg = await sbx.commands.run('echo started; sleep 1; echo finished', { background: true });
yes('background returns a handle with a pid', typeof bg.pid === 'number');
const bgr = await bg.wait();
is('background wait()', [bgr.exitCode, bgr.stdout], [0, 'started\nfinished\n']);
const bg2 = await sbx.commands.run('sleep 30', { background: true });
is('kill a background command', await bg2.kill(), true);

// ---- isolation ----------------------------------------------------------------------
const probe = '/tmp/sandboxtest_host_only'; writeFileSync(probe, 'host');
is('a host file is unreachable', (await sbx.runCode(`open(${JSON.stringify(probe)}).read()`)).error?.name, 'FileNotFoundError');
try { unlinkSync(probe); } catch {}
is('a guest write does not reach the host', [await sbx.files.exists('/work/py.txt'), existsSync('/work/py.txt')], [true, false]);
is('no network', (await sbx.runCode('import socket; socket.create_connection(("1.1.1.1",80),2)')).error?.name, 'ConnectionRefusedError');

// ---- serialisation and independence -----------------------------------------------------
const order = await Promise.all([1, 2, 3, 4, 5].map((i) => sbx.runCode(`z = ${i}; z`)));
is('concurrent calls on one sandbox are serialised', order.map((e) => e.text), ['1', '2', '3', '4', '5']);
const sbx2 = await Sandbox.create();
await Promise.all([sbx.runCode('who = "one"'), sbx2.runCode('who = "two"')]);
is('sandboxes are independent', [(await sbx.runCode('who')).text, (await sbx2.runCode('who')).text], ["'one'", "'two'"]);
is('...including files', await sbx2.files.exists('/work/py.txt'), false);
is('connect() finds a sandbox by id', (await Sandbox.connect(sbx2.sandboxId)) === sbx2, true);

// ---- timeouts ----------------------------------------------------------------------------
await rejects('a cell past timeoutMs throws TimeoutError', sbx.runCode('import time\nwhile True:\n    time.sleep(0.01)', { timeoutMs: 3000 }), TimeoutError);
is('...and the sandbox is still usable, state intact', (await sbx.runCode('x')).text, '11');

// The case that took the host down when this ran in-process: a cell spinning in
// compiled code, with no syscall to deliver a signal at. The worker is abandoned;
// the host must stay alive and say so.
let beats = 0; const hb = setInterval(() => beats++, 20);
const t0 = Date.now();
await rejects('a busy-loop cell throws TimeoutError', sbx2.runCode('while True:\n    pass', { timeoutMs: 2000 }), TimeoutError);
clearInterval(hb);
const took = Date.now() - t0;
yes(`...within a bounded time (${took} ms)`, took < 2000 + 5000 + 4000);
yes(`...while the host's event loop kept running (${beats} ticks)`, beats > 50);
is('the wedged sandbox is reported not running', await sbx2.isRunning(), false);
await rejects('...and refuses further work', sbx2.runCode('1'), SandboxNotFoundError);
is('an unrelated sandbox is untouched', (await sbx.runCode('x')).text, '11');

// ---- lifecycle and honesty ------------------------------------------------------------------
yes('sandboxId is a string', typeof sbx.sandboxId === 'string' && sbx.sandboxId.length > 8);
is('isRunning', await sbx.isRunning(), true);
// ---- an interactive terminal -----------------------------------------------------------------------------
{
  let term = '';
  const pty = await sbx.pty.create({ cols: 90, rows: 20, onData: (b) => { term += Buffer.from(b).toString(); } });
  const until = async (re, ms = 20000) => { const t = Date.now(); while (!re.test(term) && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 50)); return re.test(term); };
  yes('a pty shell shows a prompt', await until(/[#$] $/));
  term = ''; await pty.sendInput('echo pty-$((6*7))\n');
  yes('it runs what is typed and echoes it', await until(/pty-42\r\n/));
  is('it exits with the shell\'s status', (await (async () => { await pty.sendInput('exit 3\n'); return pty.wait(); })()).exitCode, 3);
}

// ---- a sandbox that outlives its process: snapshot, then restore ------------------------------------------
{
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = join(mkdtempSync(join(tmpdir(), 'oxsnap-')), 's');
  const A = await Sandbox.create();
  await A.run('import os\nvalue = 41\nos.makedirs("/work/sub", exist_ok=True)\nopen("/work/data.txt", "w").write("kept")\nos.symlink("/work/data.txt", "/work/link")\nos.remove("/etc/group")\nos.chmod("/work/data.txt", 0o600)');
  await A.snapshot(dir);
  await A.kill();
  const B = await Sandbox.create({ restore: dir });
  is('restore: a variable survives', (await B.run('value + 1')).trim(), '42');
  is('...a file the guest wrote', (await B.run('open("/work/data.txt").read()')).trim(), "'kept'");
  is('...a symlink and what it points at', (await B.run('open("/work/link").read() + str(os.path.islink("/work/link"))')).trim(), "'keptTrue'");
  is('...a file it deleted stays deleted', (await B.run('os.path.exists("/etc/group")')).trim(), 'False');
  is('...a mode it set', (await B.run('oct(os.stat("/work/data.txt").st_mode & 0o777)')).trim(), "'0o600'");
  is('...and it still runs commands', (await B.sh('echo alive')).stdout.trim(), 'alive');
  await rejects('a snapshot refuses to restore under different options', Sandbox.create({ restore: dir, memMB: 700 }), SandboxError);
  await rejects('...and a directory that is not a snapshot', Sandbox.create({ restore: tmpdir() }), SandboxError);
  await B.kill(); rmSync(join(dir, '..'), { recursive: true, force: true });
  // busy: a background process is live state a snapshot cannot hold
  const C = await Sandbox.create();
  const bg = await C.commands.run('sleep 30', { background: true });
  await rejects('snapshot refuses while a background process runs', C.snapshot(join(tmpdir(), 'oxsnap-busy')), SandboxError);
  await C.kill();
}

// ---- a server inside the sandbox, reached from the host (getHost) ------------------------------
{
  const H = await Sandbox.create();
  await H.runCode(`import socket, threading
L = socket.socket()
L.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
L.bind(("0.0.0.0", 7000)); L.listen(5)
def serve():
    while True:
        c, _ = L.accept()
        c.sendall(b"hello from guest\\n"); c.close()
threading.Thread(target=serve, daemon=True).start()
`);
  const host = await H.getHost(7000);
  const net = await import('node:net');
  const got = await new Promise((res) => { const k = net.connect(+host.split(':')[1], '127.0.0.1'); let d = ''; k.on('data', (b) => { d += b; }); k.on('close', () => res(d)); setTimeout(() => res('timeout:' + d), 30000).unref(); });
  is('getHost: a guest listener answers a host client', got, 'hello from guest\n');
  const deadPort = +(await H.getHost(7001)).split(':')[1];
  const refused = await new Promise((res) => { const k = net.connect(deadPort, '127.0.0.1'); k.on('close', () => res('closed')); k.on('data', () => res('data')); k.on('error', () => {}); setTimeout(() => res('hung'), 15000).unref(); });
  is('...a port nothing listens on is closed straight away', refused, 'closed');
  await H.kill();
}

// ---- the network: off by default, bridged and policed when asked for ----------------------------------------------
{
  const { createServer } = await import('node:http');
  const { createSocket } = await import('node:dgram');
  const { networkInterfaces } = await import('node:os');
  const ip = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  if (!ip) console.log('  (no non-loopback address: network checks skipped)');
  else {
    const srv = createServer((q, r) => r.end('from-host')).listen(0, '0.0.0.0');
    await new Promise((r) => srv.once('listening', r));
    const port = srv.address().port;
    const udp = createSocket('udp4'); udp.on('message', (m, r) => udp.send(Buffer.concat([Buffer.from('echo:'), m]), r.port, r.address));
    await new Promise((r) => udp.bind(0, '0.0.0.0', r));
    const uport = udp.address().port;
    const GET = `import socket\nc=socket.create_connection(("${ip}",${port}),timeout=30)\nc.sendall(b"GET / HTTP/1.0\\r\\n\\r\\n")\nd=b""\nwhile True:\n  x=c.recv(4096)\n  if not x: break\n  d+=x\nd.split(b"\\r\\n\\r\\n")[1].decode()`;
    const off = await Sandbox.create();
    const offRes = await off.runCode(`import socket\ntry:\n  socket.create_connection(("${ip}",${port}),timeout=5)\n  r="connected"\nexcept OSError as e:\n  r=type(e).__name__\nr`);
    is('without network the guest cannot connect', offRes.text, "'ConnectionRefusedError'");
    await off.kill();
    const priv = await Sandbox.create({ network: true });
    const blocked = await priv.runCode(`import socket\ntry:\n  socket.create_connection(("10.255.255.1",80),timeout=5)\n  r="connected"\nexcept OSError as e:\n  r=e.errno\nr`);
    is('network: true refuses a private address by default (ENETUNREACH)', blocked.text, '101');
    await priv.kill();
    const net = await Sandbox.create({ network: { allowPrivate: true } });
    is('TCP to a host server', (await net.runCode(GET)).text, "'from-host'");
    is('...a closed port is ECONNREFUSED', (await net.runCode(`import socket\ntry:\n  socket.create_connection(("${ip}",1),timeout=10)\n  r="connected"\nexcept OSError as e:\n  r=e.errno\nr`)).text, '111');
    is('UDP round trip', (await net.runCode(`import socket\nu=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)\nu.settimeout(20)\nu.sendto(b"x",("${ip}",${uport}))\nu.recvfrom(100)[0]`)).text, "b'echo:x'");
    await net.kill(); srv.close(); udp.close();
  }
}

await rejects('an unsupported language says so', sbx.runCode('1', { language: 'r' }), SandboxError);
is('kill', await sbx.kill(), true);
is('killed sandbox is not running', await sbx.isRunning(), false);
await rejects('a killed sandbox refuses work', sbx.runCode('1'), SandboxNotFoundError);
is('Sandbox.kill on an unknown id', await Sandbox.kill('nope'), false);

console.log(`\n${pass}/${pass + fail} SDK checks (persistent state, isolation, containment)`);
process.exit(fail ? 1 : 0);

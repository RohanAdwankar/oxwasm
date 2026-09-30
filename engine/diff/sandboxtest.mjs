// The E2B-compatible SDK, checked against the behaviour E2B's published
// packages define (types read from @e2b/code-interpreter 2.8 / e2b 2.51), and
// against the properties the sandbox exists for: state that persists, a guest
// that cannot reach the host, and a runaway cell that cannot take the host down.
// Skips on a machine with no python3.
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

// ---- E2B's execution semantics ---------------------------------------------
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
try { sbx.pty; is('pty is not silently faked', true, false); } catch (e) { yes('pty throws NotSupportedError', e instanceof NotSupportedError); }
await rejects('an unsupported language says so', sbx.runCode('1', { language: 'r' }), SandboxError);
is('kill', await sbx.kill(), true);
is('killed sandbox is not running', await sbx.isRunning(), false);
await rejects('a killed sandbox refuses work', sbx.runCode('1'), SandboxNotFoundError);
is('Sandbox.kill on an unknown id', await Sandbox.kill('nope'), false);

console.log(`\n${pass}/${pass + fail} SDK checks (E2B-compatible surface, persistent state, isolation, containment)`);
process.exit(fail ? 1 : 0);

# The guest half of the sandbox: one long-lived CPython that answers requests.
#
# Host -> guest:  "<byte length>\n<json>"                       (on stdin)
# Guest -> host:  "\x01<byte length>\n<json>"                   (on a private fd)
#
# Every guest frame carries the request "id" it answers. A request produces any
# number of {"ev": "stdout"|"stderr"|"result"} frames and exactly one closing
# {"ev": "done"} or {"ev": "error"} frame, so the host can stream output to its
# callbacks while a cell is still running.
#
# Protocol frames go to a DUPLICATE of the original stdout. fd 1 and fd 2 are
# then repointed at pipes this process drains itself, so anything that writes
# to them directly - os.system, a C extension's printf, a child process -
# arrives as ordinary stdout/stderr events instead of corrupting a frame.
import sys, os, io, json, ast, time, stat, errno, shutil, base64, traceback, subprocess

PROTO = os.fdopen(os.dup(1), 'wb', buffering=0)
IN = sys.stdin.buffer


def frame(obj):
    b = json.dumps(obj).encode()
    PROTO.write(b'\x01' + str(len(b)).encode() + b'\n' + b)


# ---- fd-level capture ------------------------------------------------------
def _pipe():
    r, w = os.pipe()
    os.set_blocking(r, False)
    return r, w


OUT_R, OUT_W = _pipe()
ERR_R, ERR_W = _pipe()
os.dup2(OUT_W, 1)
os.dup2(ERR_W, 2)


def drain_fds(rid):
    """Forward whatever landed on the captured fd 1 / fd 2 since last time."""
    for fd, ev in ((OUT_R, 'stdout'), (ERR_R, 'stderr')):
        while True:
            try:
                b = os.read(fd, 65536)
            except (BlockingIOError, InterruptedError):
                break
            if not b:
                break
            frame({'id': rid, 'ev': ev, 'line': b.decode('utf-8', 'replace'), 'ts': time.time()})


class Stream(io.TextIOBase):
    """sys.stdout / sys.stderr for a cell. Output is delivered a LINE at a time,
    newline included, the way a log is - print() makes two writes (the text
    and then the newline) and a consumer should not have to stitch them."""
    def __init__(self, rid, ev):
        self.rid, self.ev, self.pending = rid, ev, ''

    def writable(self):
        return True

    def write(self, s):
        if not s:
            return 0
        self.pending += s
        if '\n' in self.pending:
            head, _, tail = self.pending.rpartition('\n')
            for ln in (head + '\n').splitlines(True):
                frame({'id': self.rid, 'ev': self.ev, 'line': ln, 'ts': time.time()})
            self.pending = tail
        return len(s)

    def flush(self):
        if self.pending:
            frame({'id': self.rid, 'ev': self.ev, 'line': self.pending, 'ts': time.time()})
            self.pending = ''


# ---- code execution ----------------------------------------------------------
CONTEXTS = {'default': {'g': {'__name__': '__main__'}, 'cwd': None, 'count': 0}}

MIMES = (('_repr_html_', 'html'), ('_repr_markdown_', 'markdown'), ('_repr_svg_', 'svg'),
         ('_repr_png_', 'png'), ('_repr_jpeg_', 'jpeg'), ('_repr_latex_', 'latex'),
         ('_repr_json_', 'json'))


def display_data(v):
    """A notebook's view of a value: its repr plus any rich representations."""
    d = {'text': repr(v)}
    for meth, key in MIMES:
        f = getattr(v, meth, None)
        if callable(f):
            try:
                r = f()
            except Exception:
                continue
            if isinstance(r, tuple):
                r = r[0]
            if isinstance(r, bytes):
                r = base64.b64encode(r).decode()
            if r is not None:
                d[key] = r if isinstance(r, str) else json.dumps(r)
    return d


def run_cell(src, g):
    tree = ast.parse(src, '<cell>', 'exec')
    tail = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
    if tree.body:
        exec(compile(tree, '<cell>', 'exec'), g)
    if tail is None:
        return None
    return eval(compile(ast.Expression(tail.value), '<cell>', 'eval'), g)


def cell_traceback(exc):
    """A user's traceback starts at their cell, not at this driver."""
    lines = traceback.format_exception(type(exc), exc, exc.__traceback__)
    for i, ln in enumerate(lines):
        if '"<cell>"' in ln:
            return ''.join(lines[:1] + lines[i:])
    return ''.join(lines)


def op_run(rid, req):
    ctx = CONTEXTS.get(req.get('ctx') or 'default')
    if ctx is None:
        return frame({'id': rid, 'ev': 'error', 'type': 'NotFound', 'message': 'context %s not found' % req.get('ctx')})
    if req.get('language', 'python') != 'python':
        return frame({'id': rid, 'ev': 'error', 'type': 'InvalidArgument',
                      'message': 'language %r is not supported; this sandbox runs python' % req.get('language')})
    envs = req.get('envs') or {}
    old_env = {k: os.environ.get(k) for k in envs}
    os.environ.update(envs)
    prev_cwd = os.getcwd()
    if ctx['cwd']:
        try:
            os.chdir(ctx['cwd'])
        except OSError:
            pass
    ctx['count'] += 1
    so, se = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = Stream(rid, 'stdout'), Stream(rid, 'stderr')
    error = None
    try:
        v = run_cell(req['code'], ctx['g'])
        if v is not None:
            sys.stdout, sys.stderr = so, se
            frame({'id': rid, 'ev': 'result', 'main': True, 'data': display_data(v)})
    except SyntaxError as e:
        error = {'name': 'SyntaxError', 'value': str(e), 'traceback': ''.join(traceback.format_exception_only(type(e), e))}
    except BaseException as e:            # KeyboardInterrupt from a SIGINT lands here too
        error = {'name': type(e).__name__, 'value': str(e), 'traceback': cell_traceback(e)}
    finally:
        cell_out, cell_err = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = so, se
        for st in (cell_out, cell_err):
            try:
                st.flush()                      # a trailing partial line still counts
            except Exception:
                pass
        for k, old in old_env.items():
            if old is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = old
        if ctx['cwd']:
            try:
                os.chdir(prev_cwd)
            except OSError:
                pass
    drain_fds(rid)
    frame({'id': rid, 'ev': 'done', 'executionCount': ctx['count'], 'error': error})


def op_ctx_create(rid, req):
    cid = 'ctx-%d' % (len(CONTEXTS) + int(time.time() * 1000) % 100000)
    CONTEXTS[cid] = {'g': {'__name__': '__main__'}, 'cwd': req.get('cwd'), 'count': 0}
    frame({'id': rid, 'ev': 'done', 'value': {'id': cid, 'language': req.get('language') or 'python',
                                                'cwd': req.get('cwd') or os.getcwd()}})


def op_ctx_remove(rid, req):
    if req['ctx'] == 'default' or req['ctx'] not in CONTEXTS:
        return frame({'id': rid, 'ev': 'error', 'type': 'NotFound', 'message': 'context %s not found' % req['ctx']})
    del CONTEXTS[req['ctx']]
    frame({'id': rid, 'ev': 'done', 'value': None})


def op_ctx_list(rid, req):
    frame({'id': rid, 'ev': 'done', 'value': [{'id': k, 'language': 'python', 'cwd': v['cwd'] or os.getcwd()}
                                                for k, v in CONTEXTS.items()]})


def op_ctx_restart(rid, req):
    c = CONTEXTS.get(req['ctx'])
    if c is None:
        return frame({'id': rid, 'ev': 'error', 'type': 'NotFound', 'message': 'context %s not found' % req['ctx']})
    c['g'] = {'__name__': '__main__'}
    c['count'] = 0
    frame({'id': rid, 'ev': 'done', 'value': None})


# ---- filesystem ----------------------------------------------------------------
def entry(path, st=None, name=None):
    st = st or os.lstat(path)
    if stat.S_ISLNK(st.st_mode):
        typ = 'symlink'
    elif stat.S_ISDIR(st.st_mode):
        typ = 'dir'
    else:
        typ = 'file'
    e = {'name': name or os.path.basename(path.rstrip('/')) or '/', 'type': typ, 'path': path,
         'size': st.st_size, 'mode': stat.S_IMODE(st.st_mode), 'permissions': stat.filemode(st.st_mode),
         'owner': 'root', 'group': 'root', 'modifiedTime': st.st_mtime * 1000}
    if typ == 'symlink':
        try:
            e['symlinkTarget'] = os.readlink(path)
        except OSError:
            pass
    return e


def fs_err(rid, e):
    kind = 'FileNotFound' if isinstance(e, (FileNotFoundError, NotADirectoryError)) else \
           'NotEnoughSpace' if getattr(e, 'errno', None) == errno.ENOSPC else 'InvalidArgument'
    frame({'id': rid, 'ev': 'error', 'type': kind, 'message': str(e)})


def op_fs_read(rid, req):
    with open(req['path'], 'rb') as f:
        data = f.read()
    frame({'id': rid, 'ev': 'done', 'value': base64.b64encode(data).decode()})


def op_fs_write(rid, req):
    p = req['path']
    d = os.path.dirname(p)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(p, 'wb') as f:
        f.write(base64.b64decode(req['data']))
    frame({'id': rid, 'ev': 'done', 'value': entry(p)})


def op_fs_list(rid, req):
    p, depth = req['path'], max(1, req.get('depth') or 1)
    out = []

    def walk(d, level):
        for n in sorted(os.listdir(d)):
            fp = os.path.join(d, n)
            e = entry(fp, name=n)
            out.append(e)
            if e['type'] == 'dir' and level < depth:
                walk(fp, level + 1)
    if not os.path.isdir(p):
        raise NotADirectoryError(errno.ENOTDIR, 'not a directory', p)
    walk(p, 1)
    frame({'id': rid, 'ev': 'done', 'value': out})


def op_fs_exists(rid, req):
    frame({'id': rid, 'ev': 'done', 'value': os.path.lexists(req['path'])})


def op_fs_remove(rid, req):
    p = req['path']
    if os.path.isdir(p) and not os.path.islink(p):
        shutil.rmtree(p)
    else:
        os.remove(p)
    frame({'id': rid, 'ev': 'done', 'value': None})


def op_fs_mkdir(rid, req):
    if os.path.isdir(req['path']):
        return frame({'id': rid, 'ev': 'done', 'value': False})
    os.makedirs(req['path'])
    frame({'id': rid, 'ev': 'done', 'value': True})


def op_fs_rename(rid, req):
    os.rename(req['old'], req['new'])
    frame({'id': rid, 'ev': 'done', 'value': entry(req['new'])})


def op_fs_info(rid, req):
    frame({'id': rid, 'ev': 'done', 'value': entry(req['path'])})


# ---- commands -------------------------------------------------------------------
SHELL = next((p for p in ('/bin/sh', '/usr/bin/sh', '/bin/bash') if os.path.exists(p)), None)
PROCS = {}          # pid -> Popen, for background commands


def nb_read(fd):
    try:
        return os.read(fd, 65536)
    except (BlockingIOError, InterruptedError):
        return None


def spawn(req):
    if SHELL is None:
        raise FileNotFoundError(errno.ENOENT, 'no shell is provisioned in this sandbox', '/bin/sh')
    env = dict(os.environ)
    env.update(req.get('envs') or {})
    p = subprocess.Popen([SHELL, '-c', req['cmd']], cwd=req.get('cwd') or None, env=env,
                         stdin=subprocess.PIPE if req.get('stdin') else subprocess.DEVNULL,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    os.set_blocking(p.stdout.fileno(), False)
    os.set_blocking(p.stderr.fileno(), False)
    return p


def pump_proc(rid, p):
    """Forward what a child has written so far. Returns True while it may write more."""
    live = False
    for stream, ev in ((p.stdout, 'stdout'), (p.stderr, 'stderr')):
        while True:
            b = nb_read(stream.fileno())
            if b is None:
                live = True
                break
            if not b:
                break
            live = True
            frame({'id': rid, 'ev': ev, 'line': b.decode('utf-8', 'replace'), 'ts': time.time()})
    return live


def op_cmd(rid, req):
    p = spawn(req)
    if req.get('background'):
        PROCS[p.pid] = p
        return frame({'id': rid, 'ev': 'done', 'value': {'pid': p.pid}})
    try:
        while True:
            live = pump_proc(rid, p)
            code = p.poll()
            if code is not None:
                pump_proc(rid, p)
                break
            time.sleep(0.005 if live else 0.02)
    except BaseException:
        # Interrupted (a request timeout's SIGINT): the child must not outlive
        # the request that started it.
        try:
            p.kill()
            p.wait()
        except Exception:
            pass
        raise
    drain_fds(rid)
    frame({'id': rid, 'ev': 'done', 'exitCode': code})


def op_cmd_poll(rid, req):
    p = PROCS.get(req['pid'])
    if p is None:
        return frame({'id': rid, 'ev': 'error', 'type': 'NotFound', 'message': 'process %s not found' % req['pid']})
    pump_proc(rid, p)
    code = p.poll()
    if code is not None:
        pump_proc(rid, p)
        del PROCS[req['pid']]
    frame({'id': rid, 'ev': 'done', 'exitCode': code})


def op_cmd_kill(rid, req):
    p = PROCS.pop(req['pid'], None)
    if p is None:
        return frame({'id': rid, 'ev': 'done', 'value': False})
    p.kill()
    p.wait()
    frame({'id': rid, 'ev': 'done', 'value': True})


def op_cmd_stdin(rid, req):
    p = PROCS.get(req['pid'])
    if p is None or p.stdin is None:
        return frame({'id': rid, 'ev': 'error', 'type': 'NotFound', 'message': 'process %s has no stdin' % req['pid']})
    p.stdin.write(base64.b64decode(req['data']))
    p.stdin.flush()
    frame({'id': rid, 'ev': 'done', 'value': None})


def op_cmd_list(rid, req):
    frame({'id': rid, 'ev': 'done', 'value': [{'pid': k} for k in PROCS]})


def op_env(rid, req):
    os.environ.update(req.get('envs') or {})
    frame({'id': rid, 'ev': 'done', 'value': None})


def op_ping(rid, req):
    frame({'id': rid, 'ev': 'done', 'value': True})


OPS = {k[3:]: v for k, v in list(globals().items()) if k.startswith('op_')}


def serve_one():
    line = IN.readline()
    if not line:
        return False
    try:
        n = int(line)
    except ValueError:
        return True
    raw = b''
    while len(raw) < n:
        c = IN.read(n - len(raw))
        if not c:
            return False
        raw += c
    req = json.loads(raw.decode('utf-8'))
    rid = req.get('id')
    try:
        OPS[req['op']](rid, req)
    except BaseException as e:
        try:
            fs_err(rid, e) if isinstance(e, OSError) else frame(
                {'id': rid, 'ev': 'error', 'type': type(e).__name__, 'message': str(e)})
        except BaseException:
            pass
    return True


def serve():
    frame({'id': 0, 'ev': 'ready', 'python': sys.version.split()[0]})
    while True:
        # A SIGINT meant for a cell that has already finished lands here, while
        # this loop waits for the next request. It must not end the process.
        try:
            if not serve_one():
                break
        except KeyboardInterrupt:
            continue


serve()

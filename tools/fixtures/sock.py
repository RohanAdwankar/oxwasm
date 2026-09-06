# sock.py - a TCP echo server on the loopback and a client in threads, then
# an AF_UNIX stream server on a path, then a datagram exchange; each step
# prints what the peer saw so native and engine compare byte for byte
import socket, threading, os, select, tempfile, struct
srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(('127.0.0.1', 0)); srv.listen(2)
port = srv.getsockname()[1]
print('bound', port > 1024, srv.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) == socket.SOCK_STREAM)
log = []   # the server thread's lines, printed after join: the two threads' prints would otherwise interleave by scheduling
def serve(n):
    for _ in range(n):
        c, addr = srv.accept()
        log.append(('accepted from loopback', addr[0] == '127.0.0.1', addr[1] > 1024))
        data = b''
        while True:
            chunk = c.recv(4096)
            if not chunk: break
            data += chunk
            if data.endswith(b'\n'): break
        c.sendall(data.upper()); c.shutdown(socket.SHUT_WR); c.close()
t = threading.Thread(target=serve, args=(2,)); t.start()
for msg in (b'hello over tcp\n', b'x' * 70000 + b'\n'):
    cl = socket.create_connection(('127.0.0.1', port))
    cl.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    print('peer', cl.getpeername()[1] == port)
    cl.sendall(msg)
    got = b''
    while True:
        r, _, _ = select.select([cl], [], [], 5)
        if not r: print('timeout'); break
        chunk = cl.recv(65536)
        if not chunk: break
        got += chunk
    print('echo', len(got), got[:12], got == msg.upper())
    cl.close()
t.join(); srv.close()
for line in log: print(*line)
try:
    socket.create_connection(('127.0.0.1', port), timeout=2); print('connected to a closed port?')
except OSError as e: print('refused', e.errno)
d = tempfile.mkdtemp(); path = os.path.join(d, 's')
us = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); us.bind(path); us.listen(1)
print('socket node', os.path.exists(path), __import__('stat').S_ISSOCK(os.stat(path).st_mode))
def userve():
    c, _ = us.accept(); c.sendall(b'unix hi'); c.close()
t = threading.Thread(target=userve); t.start()
uc = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); uc.connect(path)
print('unix got', uc.recv(100), uc.recv(100))
t.join(); uc.close(); us.close(); os.unlink(path)
try:
    socket.socket(socket.AF_UNIX, socket.SOCK_STREAM).connect(path); print('connected after unlink?')
except OSError as e: print('unix refused', e.errno)
a = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM); a.bind(os.path.join(d, 'a'))
b = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM); b.bind(os.path.join(d, 'b'))
a.sendto(b'one', os.path.join(d, 'b')); a.sendto(b'two', os.path.join(d, 'b'))
print('dgram', b.recvfrom(10)[0], b.recvfrom(10)[1].endswith('/a'))
b.setblocking(False)
try: b.recv(10); print('dgram empty read?')
except BlockingIOError as e: print('dgram empty', e.errno)
# a descriptor passed over a socketpair
p, q = socket.socketpair()
r, w = os.pipe(); os.write(w, b'through the pipe')
socket.send_fds(p, [b'fd'], [r])
msg, fds, flags, addr = socket.recv_fds(q, 10, 1)
print('fd passed', msg, len(fds), os.read(fds[0], 100))
p.close(); q.close()
os.unlink(os.path.join(d, 'a')); os.unlink(os.path.join(d, 'b')); os.rmdir(d)
print('done')

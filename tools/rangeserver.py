#!/usr/bin/env python3
"""HTTP server with Range support — required for v86's chunked async disks."""
import http.server, os, re, sys

class H(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            return super().send_head()
        rng = self.headers.get('Range')
        f = open(path, 'rb')
        size = os.fstat(f.fileno()).st_size
        if rng:
            m = re.match(r'bytes=(\d+)-(\d*)', rng)
            start = int(m.group(1)); end = int(m.group(2)) if m.group(2) else size - 1
            end = min(end, size - 1)
            self.send_response(206)
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self.send_header('Content-Length', str(end - start + 1))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Type', 'application/octet-stream')
            self.end_headers()
            f.seek(start)
            self.wfile.write(f.read(end - start + 1))
            f.close()
            return None
        self.send_response(200)
        self.send_header('Content-Length', str(size))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Type', 'application/octet-stream' if not path.endswith('.html') else 'text/html')
        self.end_headers()
        return f

http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()

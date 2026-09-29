#!/usr/bin/env python3
"""Read-only loopback preview of an existing private replay, without directory listing."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import mimetypes
from pathlib import Path
import secrets
from urllib.parse import urlsplit

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
output = args.output.resolve(strict=True)
prefix = '/' + secrets.token_urlsafe(24) + '/'
allowed = {'comparison.html', 'test-document.html', 'test-document.pdf', 'reference.pdf',
           'generated-title-1.xml', 'comparison.json', 'pdf-comparison.json'}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        path = urlsplit(self.path).path
        name = path[len(prefix):] if path.startswith(prefix) else ''
        file = output / name
        if name not in allowed or file.is_symlink() or not file.is_file():
            self.send_error(404)
            return
        raw = file.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', mimetypes.guess_type(name)[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(raw)


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
print(f'http://127.0.0.1:{server.server_port}{prefix}comparison.html', flush=True)
server.serve_forever()

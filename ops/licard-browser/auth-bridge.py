#!/usr/bin/env python3
"""Accept only Licard login and confirmation requests over the local CRM socket."""
import json
import os
import secrets
import socketserver
import stat
import subprocess
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path

SOCKET = Path('/opt/artel-crm/data/operations/.licard-auth.sock')
challenge = None
last_login = 0


def authorize(request):
    global challenge, last_login
    now = time.monotonic()
    action = request.get('action')
    actor = request.get('actor')
    if not isinstance(actor, str) or not actor or len(actor) > 150:
        return {'state': 'error'}
    if action == 'login':
        if challenge and now < challenge['expires'] and challenge['actor'] != actor:
            return {'state': 'busy'}
        if now - last_login < 30:
            return {'state': 'retry_later'}
        login, password = request.get('login'), request.get('password')
        if not isinstance(login, str) or not 0 < len(login) <= 320 or not isinstance(password, str) or not 0 < len(password) <= 4096:
            return {'state': 'error'}
        last_login = now
        challenge = None
        fields = {'login': login, 'password': password}
    elif action == 'code':
        code = request.get('code')
        if not challenge or challenge['actor'] != actor or challenge['token'] != request.get('challenge'):
            return {'state': 'expired'}
        if now >= challenge['expires'] or challenge['attempts'] >= 5:
            challenge = None
            return {'state': 'expired'}
        if not isinstance(code, str) or not code.isascii() or not code.isdecimal() or not 4 <= len(code) <= 10:
            return {'state': 'error'}
        challenge['attempts'] += 1
        fields = {'code': code}
    else:
        return {'state': 'error'}

    result = subprocess.run(
        ['docker', 'exec', '-i', 'artel-licard-browser', 'node', '/state/worker/collect.mjs', action],
        input=json.dumps(fields), text=True, capture_output=True, timeout=28, check=True,
    )
    state = json.loads(result.stdout)['state']
    if state == 'code_required' and action == 'login':
        token = secrets.token_urlsafe(24)
        challenge = {'actor': actor, 'token': token, 'expires': time.monotonic() + 900, 'attempts': 0}
        return {'state': state, 'challenge': token}
    if state == 'connected':
        challenge = None
        # systemd also serializes refreshes started by the timer.
        subprocess.run(['systemctl', 'start', '--no-block', 'artel-licard-balance.service'],
                       timeout=3, check=True, capture_output=True)
    if state == 'expired':
        challenge = None
    return {'state': state}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def setup(self):
        self.request.settimeout(5)
        super().setup()

    def do_POST(self):
        result = {'state': 'error'}
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if self.path == '/authorize' and 0 < size <= 16384:
                payload = json.loads(self.rfile.read(size))
                if isinstance(payload, dict):
                    result = authorize(payload)
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            pass
        output = json.dumps(result).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(output)))
        self.end_headers()
        self.wfile.write(output)


if SOCKET.exists():
    if not stat.S_ISSOCK(SOCKET.lstat().st_mode):
        raise SystemExit('Expected a local Unix socket')
    SOCKET.unlink()
with socketserver.UnixStreamServer(str(SOCKET), Handler) as server:
    os.chown(SOCKET, 0, 1000)
    os.chmod(SOCKET, 0o660)
    server.serve_forever()

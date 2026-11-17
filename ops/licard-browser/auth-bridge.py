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
RESEND_DELAY = 60
last_code_at = None


def code_response(now):
    remaining = max(0, RESEND_DELAY - int(now - last_code_at))
    return {'state': 'code_required', 'challenge': challenge['token'], 'retryAfterSeconds': remaining}


def browser_state(action, fields=None, timeout=28):
    result = subprocess.run(
        ['docker', 'exec', '-i', 'artel-licard-browser', 'node', '/state/worker/collect.mjs', action],
        input=json.dumps(fields) if fields is not None else '', text=True, capture_output=True, timeout=timeout, check=True,
    )
    return json.loads(result.stdout)['state']


def finish_login():
    global challenge
    challenge = None
    # A balance read already triggered by the timer may have seen the login page.
    subprocess.run(['systemctl', 'restart', '--no-block', 'artel-licard-balance.service'],
                   timeout=3, check=True, capture_output=True)
    return {'state': 'connected'}


def authorize(request):
    global challenge, last_code_at
    now = time.monotonic()
    action = request.get('action')
    actor = request.get('actor')
    if not isinstance(actor, str) or not actor or len(actor) > 150:
        return {'state': 'error'}
    if action in ('login', 'resend'):
        if challenge and now < challenge['expires']:
            if challenge['actor'] != actor:
                return {'state': 'busy'}
            if action == 'resend' and request.get('challenge') != challenge['token']:
                return {'state': 'expired'}
            if action == 'login' or now - last_code_at < RESEND_DELAY:
                state = browser_state('status', timeout=5)
                if state == 'connected':
                    return finish_login()
                if state == 'code_required':
                    return code_response(time.monotonic())
                if state not in ('expired', 'login_required'):
                    return {'state': 'error'}
                challenge = None
        if last_code_at is not None and now - last_code_at < RESEND_DELAY:
            return {'state': 'retry_later'}
        credential_dir = os.environ.get('CREDENTIALS_DIRECTORY')
        if not credential_dir:
            return {'state': 'credentials_required'}
        try:
            credentials = json.loads((Path(credential_dir) / 'licard-login').read_text())
            login, password = credentials['login'], credentials['password']
        except (OSError, ValueError, KeyError, TypeError):
            return {'state': 'credentials_required'}
        if not isinstance(login, str) or not 0 < len(login) <= 320 or not isinstance(password, str) or not 0 < len(password) <= 4096:
            return {'state': 'error'}
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

    browser_action = 'login' if action == 'resend' else action
    state = browser_state(browser_action, fields)
    if state == 'code_required' and browser_action == 'login':
        last_code_at = time.monotonic()
        challenge = {'actor': actor, 'token': secrets.token_urlsafe(24), 'expires': last_code_at + 900, 'attempts': 0}
        return code_response(last_code_at)
    if state == 'connected':
        return finish_login()
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

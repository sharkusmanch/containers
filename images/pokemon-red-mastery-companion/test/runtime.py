#!/usr/bin/env python3
"""Exercise real nginx HTTP behavior; local mode only relocates absolute paths.

Docker mode tests the runtime-base stage with built static output, read-only root/save
mounts and UID 10000. Local mode requires extracted Alpine nginx/envsubst packages.
"""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--image')
parser.add_argument('--local-root', type=Path)
parser.add_argument('--site', type=Path, default=Path('app/dist'))
args = parser.parse_args()
assert bool(args.image) != bool(args.local_root), 'choose image or local-root'
site = args.site.resolve()
root = Path(__file__).resolve().parent.parent
requests = []


class Upstream(BaseHTTPRequestHandler):
    def do_GET(self):
        requests.append((self.command, self.path, dict(self.headers)))
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'public, max-age=9999')
        self.end_headers()
        self.wfile.write(json.dumps({'path': self.path}).encode())

    def do_HEAD(self):
        requests.append((self.command, self.path, dict(self.headers)))
        self.send_response(200)
        self.end_headers()

    def log_message(self, *unused):
        pass


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def http(path, method='GET', headers=None):
    req = urllib.request.Request(origin + path, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read()


with tempfile.TemporaryDirectory(prefix='red-runtime-') as directory:
    tmp = Path(directory)
    tmp.chmod(0o755)
    saves = tmp / 'saves'
    saves.mkdir(mode=0o755)
    save = saves / 'Pokemon Red (USA, Europe).srm'
    data = bytes(range(256)) * 128
    save.write_bytes(data)
    save.chmod(0o444)
    (saves / 'other.srm').write_bytes(b'NEVER EXPOSE')
    before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in saves.iterdir()}
    upstream = ThreadingHTTPServer(('0.0.0.0', 0), Upstream)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    port = free_port()
    origin = f'http://127.0.0.1:{port}'
    upstream_port = upstream.server_address[1]
    log = (tmp / 'nginx.log').open('w+')
    base_env = {**os.environ, 'uri': '/wrong-env-substitution', 'request_method': 'WRONG'}
    process = None
    name = 'red-runtime-' + str(os.getpid())
    if args.image:
        save_path = '/saves/' + save.name
        address = f'host.docker.internal:{upstream_port}'
        command = ['docker', 'run', '--rm', '--name', name, '--read-only',
                   '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
                   '--cap-drop=ALL', '--security-opt=no-new-privileges',
                   '--add-host=host.docker.internal:host-gateway',
                   '-p', f'127.0.0.1:{port}:8080',
                   '-v', f'{saves}:/saves:ro', '-v', f'{site}:/srv/site:ro']

        def start(extra=None):
            env = {'SAVE_FILE': save_path, 'COMPANION_UPSTREAM': address,
                   'uri': '/wrong-env-substitution', 'request_method': 'WRONG', **(extra or {})}
            return subprocess.Popen(command + [item for k, v in env.items() for item in ['-e', f'{k}={v}']] + [args.image], stdout=log, stderr=log)
    else:
        local = args.local_root.resolve()
        base_env['PATH'] = f'{local}/usr/sbin:{local}/usr/bin:' + base_env['PATH']
        base_env['LD_LIBRARY_PATH'] = str(local / 'usr/lib')
        save_path = str(save)
        address = f'127.0.0.1:{upstream_port}'
        template = (root / 'nginx.conf.template').read_text()
        template = template.replace('/tmp/', str(tmp) + '/')
        template = template.replace('/etc/nginx/mime.types', str(local / 'etc/nginx/mime.types'))
        template = template.replace('/srv/site', str(site))
        template = template.replace('listen 8080;', f'listen {port};')
        (tmp / 'nginx.conf.template').write_text(template)
        entry = (root / 'entrypoint.sh').read_text().replace('/etc/nginx/nginx.conf.template', str(tmp / 'nginx.conf.template')).replace('/tmp/nginx.conf', str(tmp / 'nginx.conf'))
        (tmp / 'entrypoint.sh').write_text(entry)

        def start(extra=None):
            env = {**base_env, 'SAVE_FILE': save_path, 'COMPANION_UPSTREAM': address, **(extra or {})}
            return subprocess.Popen(['sh', str(tmp / 'entrypoint.sh')], env=env, stdout=log, stderr=log)

    try:
        # Reject config injection before nginx can start or execute a directive.
        for key, value in [('SAVE_FILE', '/saves/evil"; include /tmp/evil; #'),
                           ('SAVE_FILE', '/saves/$hostname'), ('SAVE_FILE', '/saves/a\nb'),
                           ('SAVE_FILE', '/saves/a\tb'), ('SAVE_FILE', 'relative.srm'),
                           ('COMPANION_UPSTREAM', 'localhost:8080;evil'),
                           ('COMPANION_UPSTREAM', 'localhost:0'),
                           ('COMPANION_UPSTREAM', 'localhost:65536'),
                           ('COMPANION_UPSTREAM', 'localhost:8080\n')]:
            invalid = start({key: value})
            try:
                assert invalid.wait(timeout=10) != 0, (key, 'accepted unsafe value')
            except subprocess.TimeoutExpired:
                invalid.terminate()
                raise AssertionError(f'{key}: unsafe configuration started nginx')
        print('PASS: unsafe configuration rejected')
        process = start()
        for _ in range(100):
            try:
                if http('/healthz')[0] == 200:
                    break
            except OSError:
                pass
            assert process.poll() is None, 'nginx exited before healthz'
            time.sleep(0.05)
        else:
            raise AssertionError('nginx did not start')
        status, headers, body = http('/save')
        assert (status, body) == (200, data), (status, len(body))
        assert headers['Content-Type'] == 'application/octet-stream'
        assert headers['Cache-Control'] == 'no-store'
        status, headers, body = http('/save', 'HEAD')
        assert status == 200 and not body and int(headers['Content-Length']) == len(data)
        status, headers, _ = http('/save', 'POST')
        assert status == 405 and headers['Cache-Control'] == 'no-store'
        assert http('/save', 'PUT')[0] == 405
        assert http('/save', 'DELETE')[0] == 405
        assert http('/')[2] == (site / 'index.html').read_bytes()
        assert http('/index.html')[1]['Cache-Control'] == 'no-cache'
        assets = list((site / 'assets').glob('*.js'))
        assert assets and 'immutable' in http('/assets/' + assets[0].name)[1]['Cache-Control']
        for path in ['/save/', '/save/other.srm', '/saves/other.srm', '/missing', '/favicon.ico', '/assets/missing.js']:
            status, _, body = http(path)
            assert status == 404 and body != (site / 'index.html').read_bytes(), path
        print('PASS: exact binary GET/HEAD, method denial, static/cache/missing routes')
        for game in ['724', '16084', '11632']:
            path = '/companion/api/achievements/ra/' + game
            status, headers, body = http(path, headers={'Authorization': 'Bearer TEST', 'Cookie': 'session=TEST', 'X-API-Key': 'TEST'})
            assert status == 200 and json.loads(body)['path'] == path
            assert headers['Cache-Control'] == 'no-store'
            assert not any(k.lower() in ['authorization', 'cookie', 'x-api-key'] for k in requests[-1][2])
            count = len(requests)
            assert http(path)[0] == 200 and len(requests) == count + 1
            assert http(path, 'HEAD')[0] == 200 and requests[-1][0] == 'HEAD'
            assert http(path, 'POST')[0] == 405
        count = len(requests)
        for path in ['/companion', '/companion/', '/companion/api/now', '/companion/api/guides',
                     '/companion/api/achievements/ra/999', '/companion/api/achievements/ra/0724',
                     '/companion/api/achievements/ra/724/', '/companion/api/achievements/steam/724']:
            assert http(path)[0] == 404, path
        assert len(requests) == count
        print('PASS: only three RA feeds proxied, prefix preserved, credentials stripped')
        if args.image:
            assert subprocess.run(['docker', 'exec', name, 'id', '-u'], capture_output=True, text=True, check=True).stdout.strip() == '10000'
            for path in ['/saves/write-test', '/srv/site/write-test', '/etc/write-test']:
                assert subprocess.run(['docker', 'exec', name, 'touch', path], capture_output=True).returncode != 0
            print('PASS: UID 10000, read-only save mount and root filesystem')
        after = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in saves.iterdir()}
        assert before == after
        save.rename(saves / 'temporarily-missing')
        status, headers, body = http('/save')
        assert status == 404 and headers['Cache-Control'] == 'no-store'
        assert body != (site / 'index.html').read_bytes()
        print('PASS: original save directory preserved; missing save is uncached 404')
        upstream.shutdown()
        upstream.server_close()
        assert http('/companion/api/achievements/ra/724')[0] == 502
        assert http('/')[0] == 200 and http('/healthz')[0] == 200
        print('PASS: unavailable progress service leaves static guide healthy')
    finally:
        if process:
            if args.image:
                subprocess.run(['docker', 'stop', '-t', '3', name], capture_output=True)
            else:
                process.terminate()
            process.wait(timeout=10)
        if args.image:
            subprocess.run(['docker', 'rm', '-f', name], capture_output=True)
        upstream.server_close()
        log.seek(0)
        print(log.read())
        log.close()

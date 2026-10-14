"""Run the actual native installer and OpenRC service in an isolated Linux host."""
import json
import os
import pathlib
import sqlite3
import subprocess
import time
import urllib.request

root = pathlib.Path('/tmp/native-npm-check')
root.mkdir(mode=0o755)
database = root / 'database.sqlite'
db = sqlite3.connect(database)
db.execute('CREATE TABLE proxy_host(id INTEGER,domain_names TEXT,created_on TEXT,is_deleted INTEGER)')
db.execute('INSERT INTO proxy_host VALUES(1,?,?,0)', ('["app.example.com"]', '2026-01-01'))
db.commit()
db.close()
database.chmod(0o644)
config = root / 'nginx.conf'
admin = root / 'admin.conf'
original = '''server {
    listen 81;
    server_name _;
    location = /api/users/me { default_type application/json; return 200 '{"roles":["admin"]}'; }
    location / { default_type text/html; return 200 '<html><head><title>Native NPM fixture</title></head><body>Native fixture</body></html>'; }
}
'''
admin.write_text(original)
config.write_text(f'''pid /tmp/native-npm-check/nginx.pid;
events {{ worker_connections 64; }}
http {{ include {admin}; server {{ listen 8080; return 200 'untouched site'; }} }}
''')
subprocess.run(['nginx', '-c', str(config)], check=True)
# OpenRC tools can run a real service inside this isolated container namespace.
pathlib.Path('/run/openrc').mkdir(exist_ok=True)
pathlib.Path('/run/openrc/softlevel').touch()
base_args = ['python3', 'scripts/install-linux.py', '--init', 'openrc', '--admin-config', str(admin), '--nginx-config', str(config), '--npm-sqlite', str(database)]
subprocess.run(base_args + ['--dry-run'], check=True)
assert admin.read_text() == original
subprocess.run(base_args, check=True)


def request(path, method='GET', data=None, port=81):
    headers = {'Authorization': 'Bearer fixture', 'Content-Type': 'application/json'}
    req = urllib.request.Request(f'http://127.0.0.1:{port}{path}', headers=headers, method=method,
                                 data=json.dumps(data).encode() if data is not None else None)
    with urllib.request.urlopen(req, timeout=5) as response:
        return response.read().decode()


def state():
    for _ in range(50):
        try:
            value = json.loads(request('/__cf/state'))
            if len(value['hosts']) == 1:
                return value
        except (OSError, ValueError):
            pass
        time.sleep(0.1)
    raise AssertionError('Native worker did not become ready')


assert state()['hosts'][0]['domains'] == ['app.example.com']
assert '/__cf/module.js' in request('/settings')
assert request('/', port=8080) == 'untouched site'
pid = int(pathlib.Path('/run/npm-cloudflare-dns-module.pid').read_text().strip())
status = pathlib.Path(f'/proc/{pid}/status').read_text()
assert int(status.split('Uid:\t')[1].split()[0]) != 0
assert int(status.split('CapAmb:\t')[1].split()[0], 16) == 0x400
request('/__cf/settings', 'PUT', {'defaultProxy': True})
subprocess.run(['rc-service', 'npm-cloudflare-dns-module', 'restart'], check=True)
assert state()['config']['defaultProxy'] is True
subprocess.run(['python3', 'scripts/install-linux.py', '--uninstall'], check=True)
assert admin.read_text() == original
assert '/__cf/module.js' not in request('/settings')
assert request('/', port=8080) == 'untouched site'
assert pathlib.Path('/var/lib/npm-cloudflare-dns-module/state.json').exists()
subprocess.run(['nginx', '-c', str(config), '-s', 'quit'], check=True)
print('PASS: native dry-run, install, unprivileged port 81, gateway, SQLite, restart, uninstall; other site unchanged')

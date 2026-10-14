#!/usr/bin/env python3
"""Install the gateway beside a native NPM, without Docker or changing NPM code."""
import argparse
import hashlib
import json
import os
import pathlib
try:
    import pwd
except ImportError:  # Pure configuration checks can also run on Windows.
    pwd = None
import re
import shlex
import shutil
import socket
import subprocess
import sys

SERVICE = 'npm-cloudflare-dns-module'
USER = 'npm-cf-dns'
SOURCE = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = pathlib.Path('/etc/' + SERVICE + '-install.json')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def rewrite_admin(text, port, upstream_port):
    """Touch only full listen directives for the explicitly selected admin port."""
    changes = []
    result = []
    pattern = re.compile(r'^(\s*listen\s+)([^\s;]+)([^;]*;.*)$')
    for line in text.splitlines(keepends=True):
        ending = '\r\n' if line.endswith('\r\n') else '\n' if line.endswith('\n') else ''
        raw = line.removesuffix(ending) if ending else line
        match = pattern.match(raw)
        if match:
            endpoint = match[2]
            if endpoint == str(port) or endpoint.endswith(':' + str(port)):
                # An IPv6 endpoint keeps IPv6; all other admin listeners become loopback IPv4.
                replacement = f'[::1]:{upstream_port}' if endpoint.startswith('[') else f'127.0.0.1:{upstream_port}'
                raw = match[1] + replacement + match[3]
                changes.append((endpoint, replacement))
        result.append(raw + ending)
    if not changes:
        raise ValueError('Не найдены отдельные listen-директивы порта админки; файл не изменён')
    return ''.join(result), changes


def environment(args, state):
    values = {
        'PORT': str(args.port), 'DATA_DIR': str(state),
        'NPM_URL': f'http://127.0.0.1:{args.upstream_port}',
        'NPM_SOURCE': args.source,
        'SYNC_INTERVAL_SECONDS': str(args.interval),
    }
    if args.source == 'sqlite':
        values['NPM_SQLITE_PATH'] = str(pathlib.Path(args.npm_sqlite).resolve())
    else:
        values['NPM_IDENTITY_FILE'] = str(state / 'npm-identity')
        values['NPM_SECRET_FILE'] = str(state / 'npm-secret')
    if args.ip_discovery_urls:
        values['IP_DISCOVERY_URLS'] = args.ip_discovery_urls
    # One file is valid for both systemd EnvironmentFile and POSIX shell export.
    return '\n'.join(f'{key}={shlex.quote(value)}' for key, value in values.items()) + '\n'


def systemd_unit(app, state, node, env_file):
    return f'''[Unit]
Description=Cloudflare DNS integration for Nginx Proxy Manager
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User={USER}
Group={USER}
WorkingDirectory={app}
EnvironmentFile={env_file}
ExecStart={node} {app}/src/server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=15
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths={state}
UMask=0077

[Install]
WantedBy=multi-user.target
'''


def openrc_service(app, node, env_file, setpriv):
    return f'''#!/sbin/openrc-run
name="{SERVICE}"
description="Cloudflare DNS integration for Nginx Proxy Manager"
set -a
. {env_file}
set +a
command="{setpriv}"
command_args="--reuid={USER} --regid={USER} --init-groups --inh-caps=+net_bind_service --ambient-caps=+net_bind_service {node} {app}/src/server.js"
command_background=true
pidfile="/run/{SERVICE}.pid"
output_log="/var/log/{SERVICE}.log"
error_log="/var/log/{SERVICE}.err"
depend() {{
    need net
}}
'''


def command(*args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def executable(value):
    result = shutil.which(value)
    if not result:
        raise ValueError(f'Не найден исполняемый файл: {value}')
    return pathlib.Path(result).resolve()


def account(init):
    try:
        return pwd.getpwnam(USER)
    except KeyError:
        if shutil.which('useradd'):
            command('useradd', '--system', '--user-group', '--no-create-home', '--shell', '/usr/sbin/nologin', USER)
        elif init == 'openrc' and shutil.which('adduser'):
            command('addgroup', '-S', USER)
            command('adduser', '-S', '-D', '-H', '-s', '/sbin/nologin', '-G', USER, USER)
        else:
            raise ValueError('Создайте системного пользователя npm-cf-dns или установите useradd')
        return pwd.getpwnam(USER)


def as_user(user):
    os.initgroups(user.pw_name, user.pw_gid)
    os.setgid(user.pw_gid)
    os.setuid(user.pw_uid)


def service(action, init):
    if init == 'systemd':
        command('systemctl', action, SERVICE)
    else:
        command('rc-service', SERVICE, action)


def reload_nginx(manifest):
    command(manifest['nginx_binary'], '-c', manifest['nginx_config'], '-t')
    command(manifest['nginx_binary'], '-c', manifest['nginx_config'], '-s', 'reload')


def restore_admin(manifest, state):
    path = pathlib.Path(manifest['admin_config'])
    if digest(path.read_bytes()) != manifest['patched_digest']:
        raise ValueError('Конфигурация Nginx изменена после установки. Автоматический откат отказался затирать новые правки')
    original = (state / 'admin-original.conf').read_bytes()
    if digest(original) != manifest['original_digest']:
        raise ValueError('Резервная копия admin config повреждена')
    path.write_bytes(original)
    reload_nginx(manifest)


def install(args):
    state = pathlib.Path(args.state_dir).resolve()
    app = pathlib.Path(args.app_dir).resolve()
    if MANIFEST.exists():
        raise ValueError('Модуль уже установлен; используйте --upgrade или --uninstall с тем же --state-dir')
    if app.exists():
        raise ValueError('Каталог приложения уже существует; выберите пустой --app-dir')
    # Generated service files deliberately support conventional Linux paths only.
    for value in [str(app), str(state), args.node_binary, args.nginx_binary]:
        if re.search(r'[\s\x00-\x1f"\'`$;]', value):
            raise ValueError('Пути установки должны быть без пробелов и shell-спецсимволов')
    init = args.init
    if init == 'auto':
        init = 'systemd' if pathlib.Path('/run/systemd/system').is_dir() else 'openrc' if shutil.which('rc-service') else ''
    if not init:
        raise ValueError('Поддерживаются systemd и OpenRC; укажите --init')
    executable('systemctl' if init == 'systemd' else 'rc-service')
    node = executable(args.node_binary)
    version = subprocess.check_output([str(node), '-p', 'process.versions.node'], text=True).strip()
    if int(version.split('.')[0]) < 24:
        raise ValueError('Модулю нужен Node.js 24+; NPM и его Node.js автоматически не обновляются')
    nginx = executable(args.nginx_binary)
    config = pathlib.Path(args.admin_config).resolve()
    original = config.read_bytes()
    patched, changes = rewrite_admin(original.decode(), args.port, args.upstream_port)
    setpriv = executable('setpriv') if init == 'openrc' else None
    if args.source == 'sqlite' and not pathlib.Path(args.npm_sqlite).is_file():
        raise ValueError('Не найдена SQLite NPM; укажите --npm-sqlite')
    if args.source == 'api' and not (args.identity_file and args.secret_file):
        raise ValueError('API source требует --identity-file и --secret-file')
    with socket.socket() as probe:
        probe.settimeout(1)
        if probe.connect_ex(('127.0.0.1', args.upstream_port)) == 0:
            raise ValueError('Выбранный upstream-port уже занят')
    command(nginx, '-c', args.nginx_config, '-t')
    print(json.dumps({'init': init, 'adminListeners': changes, 'appDir': str(app), 'stateDir': str(state)}, ensure_ascii=False))
    if args.dry_run:
        return
    if os.geteuid() != 0:
        raise ValueError('Для установки нужны root-права; --dry-run не требует root')
    user = account(init)
    # Refuse an unreadable NPM database instead of changing permissions of NPM data.
    if args.source == 'sqlite':
        command(node, '--input-type=module', '-e', 'import {DatabaseSync} from "node:sqlite"; const d=new DatabaseSync(process.argv[1],{readOnly:true});d.prepare("SELECT id FROM proxy_host LIMIT 1").all();d.close();', str(pathlib.Path(args.npm_sqlite).resolve()), preexec_fn=lambda: as_user(user))
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chown(state, user.pw_uid, user.pw_gid)
    os.chmod(state, 0o700)
    (state / 'admin-original.conf').write_bytes(original)
    os.chmod(state / 'admin-original.conf', 0o600)
    env_file = pathlib.Path('/etc') / (SERVICE + '.env')
    if env_file.exists():
        raise ValueError('EnvironmentFile уже существует; установка остановлена')
    unit_path = pathlib.Path('/etc/systemd/system') / (SERVICE + '.service') if init == 'systemd' else pathlib.Path('/etc/init.d') / SERVICE
    if unit_path.exists():
        raise ValueError('Служба уже существует; установка остановлена')
    manifest = {'active': True, 'init': init, 'app': str(app), 'state': str(state), 'node': str(node), 'admin_config': str(config),
                'original_digest': digest(original), 'patched_digest': digest(patched.encode()),
                'nginx_binary': str(nginx), 'nginx_config': str(pathlib.Path(args.nginx_config).resolve()),
                'unit': str(unit_path), 'env': str(env_file)}
    for name in ['src', 'public']:
        shutil.copytree(SOURCE / name, app / name)
    for name in ['package.json', 'README.md']:
        shutil.copy2(SOURCE / name, app / name)
    for path in app.rglob('*'):
        os.chmod(path, 0o755 if path.is_dir() else 0o644)
    os.chmod(app, 0o755)
    if args.source == 'api':
        for source_file, name in [(args.identity_file, 'npm-identity'), (args.secret_file, 'npm-secret')]:
            target = state / name
            target.write_bytes(pathlib.Path(source_file).read_bytes())
            os.chmod(target, 0o600)
            os.chown(target, user.pw_uid, user.pw_gid)
    env_file.write_text(environment(args, state))
    os.chmod(env_file, 0o600)
    content = systemd_unit(app, state, node, env_file) if init == 'systemd' else openrc_service(app, node, env_file, setpriv)
    unit_path.write_text(content)
    os.chmod(unit_path, 0o644 if init == 'systemd' else 0o755)
    manifest['unit_digest'] = digest(unit_path.read_bytes())
    # Installation metadata must not be writable by the unprivileged daemon.
    MANIFEST.write_text(json.dumps(manifest, indent=2))
    os.chmod(MANIFEST, 0o600)
    try:
        config.write_bytes(patched.encode())
        reload_nginx(manifest)
        if init == 'systemd':
            command('systemctl', 'daemon-reload')
            command('systemctl', 'enable', '--now', SERVICE)
        else:
            command('rc-update', 'add', SERVICE, 'default')
            service('start', init)
    except Exception:
        subprocess.run(['systemctl', 'stop', SERVICE] if init == 'systemd' else ['rc-service', SERVICE, 'stop'], check=False)
        config.write_bytes(original)
        reload_nginx(manifest)
        raise
    print('Установлено. Откройте Settings → Cloudflare DNS в прежней админке NPM.')


def existing(args):
    if os.geteuid() != 0:
        raise ValueError('Нужны root-права')
    manifest = json.loads(MANIFEST.read_text())
    state = pathlib.Path(manifest['state'])
    unit = pathlib.Path(manifest['unit'])
    if digest(unit.read_bytes()) != manifest['unit_digest']:
        raise ValueError('Service file изменён пользователем; автоматическое действие отменено')
    if args.uninstall:
        # Drift is checked before stopping the live gateway.
        if digest(pathlib.Path(manifest['admin_config']).read_bytes()) != manifest['patched_digest']:
            raise ValueError('Nginx config изменён после установки; требуется ручное удаление только изменения listen')
        service('stop', manifest['init'])
        restore_admin(manifest, state)
        if manifest['init'] == 'systemd':
            command('systemctl', 'disable', SERVICE)
        else:
            command('rc-update', 'del', SERVICE, 'default')
        manifest['active'] = False
        MANIFEST.write_text(json.dumps(manifest, indent=2))
        print('Модуль остановлен; прежний порт NPM восстановлен. Данные и DNS-записи сохранены.')
    else:
        if not manifest.get('active', True):
            raise ValueError('Модуль отключён через --uninstall; --upgrade не возобновляет перехват порта NPM')
        app = pathlib.Path(manifest['app'])
        node = executable(manifest['node'])
        # Validate new sources before replacing a working installation.
        for path in (SOURCE / 'src').glob('*.js'):
            command(node, '--check', path)
        for name in ['src', 'public']:
            shutil.copytree(SOURCE / name, app / name, dirs_exist_ok=True)
        shutil.copy2(SOURCE / 'package.json', app / 'package.json')
        shutil.copy2(SOURCE / 'README.md', app / 'README.md')
        service('restart', manifest['init'])
        print('Код модуля обновлён; NPM и сохранённые настройки не изменены.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--uninstall', action='store_true')
    mode.add_argument('--upgrade', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--init', choices=['auto', 'systemd', 'openrc'], default='auto')
    parser.add_argument('--admin-config', help='Nginx file containing only the NPM admin server/listeners')
    parser.add_argument('--nginx-config', default='/etc/nginx/nginx.conf')
    parser.add_argument('--nginx-binary', default='nginx')
    parser.add_argument('--node-binary', default='node')
    parser.add_argument('--npm-sqlite', default='/data/database.sqlite')
    parser.add_argument('--source', choices=['sqlite', 'api'], default='sqlite')
    parser.add_argument('--identity-file')
    parser.add_argument('--secret-file')
    parser.add_argument('--app-dir', default='/opt/' + SERVICE)
    parser.add_argument('--state-dir', default='/var/lib/' + SERVICE)
    parser.add_argument('--port', type=int, default=81)
    parser.add_argument('--upstream-port', type=int, default=8181)
    parser.add_argument('--interval', type=int, default=60)
    parser.add_argument('--ip-discovery-urls')
    args = parser.parse_args()
    if args.dry_run and (args.upgrade or args.uninstall):
        parser.error('--dry-run применяется только к первой установке')
    if not (1 <= args.port <= 65535 and 1024 <= args.upstream_port <= 65535 and args.port != args.upstream_port and 10 <= args.interval <= 86400):
        parser.error('Некорректные порты или interval')
    if args.uninstall or args.upgrade:
        existing(args)
    else:
        if not args.admin_config:
            parser.error('Укажите --admin-config: файл nginx с административным server NPM')
        install(args)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f'Установка остановлена: {error}', file=sys.stderr)
        sys.exit(1)

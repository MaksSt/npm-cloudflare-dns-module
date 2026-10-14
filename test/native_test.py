import importlib.util
import pathlib
import tempfile
import unittest

SOURCE = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('native', SOURCE / 'scripts/install-linux.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class NativeConfigTests(unittest.TestCase):
    def test_only_admin_listeners_change(self):
        config = '''# listen 81; comment must remain
server {
    listen 80;
    listen 443 ssl;
}
server {
    listen 81 default_server;
    listen [::]:81 default_server;
    proxy_pass http://127.0.0.1:3000;
}
'''
        result, changes = native.rewrite_admin(config, 81, 8181)
        self.assertEqual(changes, [('81', '127.0.0.1:8181'), ('[::]:81', '[::1]:8181')])
        self.assertIn('listen 80;', result)
        self.assertIn('listen 443 ssl;', result)
        self.assertIn('# listen 81;', result)
        self.assertIn('proxy_pass http://127.0.0.1:3000;', result)
        self.assertIn('listen 127.0.0.1:8181 default_server;', result)

    def test_unknown_config_refuses_rewrite(self):
        with self.assertRaises(ValueError):
            native.rewrite_admin('server { listen 80; }', 81, 8181)

    def test_restore_refuses_overwriting_later_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            config = root / 'admin.conf'
            config.write_bytes(b'new user configuration')
            original = b'original nginx configuration'
            (root / 'admin-original.conf').write_bytes(original)
            manifest = {'admin_config': str(config), 'patched_digest': native.digest(b'patched config'), 'original_digest': native.digest(original)}
            with self.assertRaises(ValueError):
                native.restore_admin(manifest, root)
            self.assertEqual(config.read_bytes(), b'new user configuration')

    def test_systemd_has_no_container_dependency_and_drops_root(self):
        unit = native.systemd_unit('/opt/module', '/var/lib/module', '/usr/bin/node', '/etc/module.env')
        self.assertNotIn('docker', unit.lower())
        self.assertIn('User=npm-cf-dns', unit)
        self.assertIn('AmbientCapabilities=CAP_NET_BIND_SERVICE', unit)
        self.assertIn('ProtectSystem=strict', unit)

    def test_openrc_uses_unprivileged_user_with_only_bind_capability(self):
        unit = native.openrc_service('/opt/module', '/usr/bin/node', '/etc/module.env', '/usr/bin/setpriv')
        self.assertNotIn('docker', unit.lower())
        self.assertIn('--reuid=npm-cf-dns', unit)
        self.assertIn('--ambient-caps=+net_bind_service', unit)


if __name__ == '__main__':
    unittest.main()

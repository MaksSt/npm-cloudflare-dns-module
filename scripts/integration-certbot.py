"""Настоящий плагин Certbot, DNS-клиент подменён; реальные записи не меняются."""
from importlib.metadata import version, entry_points
from unittest.mock import Mock, patch
from certbot_dns_cloudflare._internal import dns_cloudflare
assert version('certbot') == version('certbot-dns-cloudflare')
assert any(e.name == 'dns-cloudflare' for e in entry_points(group='certbot.plugins'))
auth = dns_cloudflare.Authenticator.__new__(dns_cloudflare.Authenticator)
client = Mock()
with patch.object(auth, '_get_cloudflare_client', return_value=client):
    auth._perform('example.test', '_acme-challenge.example.test', 'disposable-validation')
    auth._cleanup('example.test', '_acme-challenge.example.test', 'disposable-validation')
client.add_txt_record.assert_called_once_with('example.test', '_acme-challenge.example.test', 'disposable-validation', 120)
client.del_txt_record.assert_called_once_with('example.test', '_acme-challenge.example.test', 'disposable-validation')
print('PASS: certbot', version('certbot'), 'cloudflare', version('certbot-dns-cloudflare'), 'entrypoint, DNS-01 perform/cleanup (mock client)')

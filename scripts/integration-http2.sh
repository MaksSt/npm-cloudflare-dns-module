#!/bin/sh
# Выполняется только в одноразовом official image; сертификат локальный тестовый.
set -eu
dir=$(mktemp -d /tmp/npm-http2-test-XXXXXXXX)
trap 'rm -rf "$dir"' EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
  -addext subjectAltName=DNS:localhost -keyout "$dir/key.pem" -out "$dir/cert.pem" >/dev/null 2>&1
cat > "$dir/nginx.conf" <<CONFIG
user root;
pid $dir/nginx.pid;
error_log $dir/error.log;
events {}
http {
  client_body_temp_path $dir/client;
  proxy_temp_path $dir/proxy;
  fastcgi_temp_path $dir/fastcgi;
  uwsgi_temp_path $dir/uwsgi;
  scgi_temp_path $dir/scgi;
  access_log off;
  server {
    listen 127.0.0.1:18443 ssl;
    http2 on;
    ssl_certificate $dir/cert.pem;
    ssl_certificate_key $dir/key.pem;
    return 200 'http2-test';
  }
}
CONFIG
nginx -e stderr -t -c "$dir/nginx.conf"
nginx -e stderr -c "$dir/nginx.conf"
test "$(curl -fsS --http2 --cacert "$dir/cert.pem" -o /dev/null -w '%{http_version}' https://localhost:18443/)" = 2
test "$(curl -fsS --http1.1 --cacert "$dir/cert.pem" -o /dev/null -w '%{http_version}' https://localhost:18443/)" = 1.1
nginx -e stderr -s quit -c "$dir/nginx.conf"
echo 'PASS: official image HTTPS with verified local certificate, HTTP/2 and HTTP/1.1'

#!/bin/sh
# Изолированные официальные NPM + SQLite/MariaDB. Production не используется.
set -eu
version=${TEST_NPM_VERSION:-2.17.1}
name="npm-cf-test-$$"
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cleanup() {
  docker rm -f "$name-npm" "$name-db" "$name-certbot" >/dev/null 2>&1 || true
  docker volume rm "$name-data" "$name-certs" "$name-dbdata" "$name-fixture" >/dev/null 2>&1 || true
  docker network rm "$name-net" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
docker pull "jc21/nginx-proxy-manager:$version"
docker pull node:24-alpine
docker pull mariadb:11
docker pull "jc21/nginx-proxy-manager:${TEST_UPGRADE_FROM:-2.17.0}"
# Устанавливаем плагин штатной функцией NPM в одноразовом контейнере.
docker run -d --name "$name-certbot" -v "$root:/adapter:ro" --entrypoint sleep "jc21/nginx-proxy-manager:$version" infinity >/dev/null
docker exec -w /app "$name-certbot" node --input-type=module -e 'import {execFileSync} from "node:child_process"; import {installPlugin} from "./lib/certbot.js"; process.env.CERTBOT_VERSION = execFileSync("/opt/certbot/bin/certbot", ["--version"]).toString().trim().split(" ").at(-1); await installPlugin("cloudflare");'
docker exec "$name-certbot" sh /adapter/scripts/integration-http2.sh
docker exec "$name-certbot" /opt/certbot/bin/pip check
docker exec "$name-certbot" /opt/certbot/bin/python /adapter/scripts/integration-certbot.py
docker rm -f "$name-certbot" >/dev/null
docker volume create "$name-fixture" >/dev/null
docker network create --internal "$name-net" >/dev/null
for backend in sqlite mariadb; do
  docker volume create "$name-data" >/dev/null
  docker volume create "$name-certs" >/dev/null
  set --
  if [ "$backend" = mariadb ]; then
    docker volume create "$name-dbdata" >/dev/null
    docker run -d --name "$name-db" --network "$name-net" \
      -v "$name-dbdata:/var/lib/mysql" -e MARIADB_ROOT_PASSWORD=disposable-root \
      -e MARIADB_DATABASE=npm -e MARIADB_USER=npm -e MARIADB_PASSWORD=disposable-db mariadb:11 >/dev/null
    set -- -e DB_MYSQL_HOST="$name-db" -e DB_MYSQL_PORT=3306 -e DB_MYSQL_USER=npm -e DB_MYSQL_PASSWORD=disposable-db -e DB_MYSQL_NAME=npm
  fi
  initial=$version
  if [ "$backend" = sqlite ]; then initial=${TEST_UPGRADE_FROM:-2.17.0}; fi
  docker run -d --name "$name-npm" --network "$name-net" \
    -v "$name-data:/data" -v "$name-certs:/etc/letsencrypt" \
    -e INITIAL_ADMIN_EMAIL=compat@example.test -e INITIAL_ADMIN_PASSWORD=Disposable-Compat-Only-2026 \
    "$@" "jc21/nginx-proxy-manager:$initial" >/dev/null
  ready=false
  for attempt in $(seq 1 60); do
    if docker exec "$name-npm" curl -fsS http://127.0.0.1:81/api/ >/dev/null 2>&1; then ready=true; break; fi
    sleep 1
  done
  if [ "$ready" != true ]; then docker logs "$name-npm"; exit 1; fi
  set --
  if [ "$backend" = sqlite ]; then set -- -v "$name-data:/npm-data:ro" -e TEST_SQLITE_PATH=/npm-data/database.sqlite; fi
  echo "Проверка NPM $version / $backend"
  docker run --rm --network "$name-net" -v "$root:/app:ro" -w /app \
    -e TEST_DISPOSABLE=yes -e TEST_NPM_URL="http://$name-npm:81" "$@" \
    node:24-alpine node scripts/integration-npm.mjs
  if [ "$backend" = sqlite ]; then
    docker run --rm --network "$name-net" -v "$root:/app:ro" -v "$name-data:/npm-data:ro" -v "$name-fixture:/fixture" -w /app -e TEST_DISPOSABLE=yes node:24-alpine node scripts/integration-sqlite.mjs seed
    docker rm -f "$name-npm" >/dev/null
    docker run -d --name "$name-npm" --network "$name-net" -v "$name-data:/data" -v "$name-certs:/etc/letsencrypt" "jc21/nginx-proxy-manager:$version" >/dev/null
    ready=false
    for attempt in $(seq 1 60); do
      if docker exec "$name-npm" curl -fsS http://127.0.0.1:81/api/ >/dev/null 2>&1; then ready=true; break; fi
      sleep 1
    done
    if [ "$ready" != true ]; then docker logs "$name-npm"; exit 1; fi
    docker run --rm --network "$name-net" -v "$root:/app:ro" -v "$name-data:/npm-data:ro" -v "$name-fixture:/fixture" -w /app -e TEST_DISPOSABLE=yes -e TEST_NPM_URL="http://$name-npm:81" node:24-alpine node scripts/integration-sqlite.mjs verify
  fi
  docker rm -f "$name-npm" >/dev/null
  docker volume rm "$name-data" "$name-certs" >/dev/null
done

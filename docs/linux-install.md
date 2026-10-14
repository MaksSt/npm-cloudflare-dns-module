# NPM на Linux без Docker

Модуль запускается обычным процессом Node.js под отдельным системным пользователем. Docker, контейнерный runtime и пересборка NPM не требуются. Поддерживаются systemd и OpenRC.

Требования: Node.js 24+, Python 3.9+, работающие NPM/nginx, root для установки службы. Для OpenRC нужен `setpriv` из util-linux; установщик не меняет системный Node.js и не устанавливает пакеты самостоятельно. Для SQLite пользователь службы должен иметь чтение базы и доступ к её родительским каталогам. Если прав недостаточно, установка остановится, не меняя разрешения NPM.

## Первая установка

Найдите nginx-файл, содержащий административный server NPM с `listen 81;`, путь к основной конфигурации nginx и SQLite. Укажите реальные пути своей установки. Не выбирайте конфигурацию сайтов на 80/443. Если административный файл генерируется стартовым скриптом дистрибутива, используйте постоянный исходный конфиг/include этой установки: перезапись listener при старте NPM нарушит подключение модуля.

Проверка плана без изменений:

```sh
sudo python3 scripts/install-linux.py \
  --admin-config /etc/nginx/conf.d/production.conf \
  --nginx-config /etc/nginx/nginx.conf \
  --npm-sqlite /data/database.sqlite \
  --dry-run
```

Для установки повторите команду без `--dry-run`. Инициализатор определяется автоматически; доступны `--init systemd` и `--init openrc`. Если nginx — OpenResty или Node.js установлен отдельно, укажите `--nginx-binary /путь/к/nginx` и `--node-binary /путь/к/node`.

Установщик:

- Проверяет Node.js, существующую конфигурацию nginx и read-only чтение SQLite от пользователя службы.
- Сохраняет исходный admin config и создаёт root-owned metadata в `/etc/npm-cloudflare-dns-module-install.json`.
- Переносит только `listen 81`/`[::]:81` в указанном файле на `127.0.0.1:8181`/`[::1]:8181`. Сайты 80/443 и backend NPM не изменяются.
- Копирует модуль в `/opt/npm-cloudflare-dns-module`, создаёт private state в `/var/lib/npm-cloudflare-dns-module` и environment file в `/etc/npm-cloudflare-dns-module.env`.
- Проверяет `nginx -t`, перезагружает nginx и включает службу. При ошибке применения возвращает исходный admin config.

Порты задаются через `--port 81 --upstream-port 8181`; upstream должен быть свободным непривилегированным портом. По прежнему адресу админки доступны **Settings → Cloudflare DNS** и столбец **CF DNS**. Пользователю остаётся сохранить Cloudflare Token в интерфейсе.

Служба работает без root. Для административного порта ниже 1024 выдаётся только `CAP_NET_BIND_SERVICE`, без изменения capabilities системного Node.js.

## Внешняя база и VPN

Вместо SQLite можно использовать API NPM:

```sh
sudo python3 scripts/install-linux.py \
  --admin-config /etc/nginx/conf.d/production.conf \
  --source api \
  --identity-file /root/npm-service-identity \
  --secret-file /root/npm-service-password
```

Файлы будут скопированы в private state службы с правами 0600. У сервисной учётной записи NPM должен быть просмотр всех Proxy Hosts и возможность API login без 2FA. Обычный вход пользователей NPM может использовать 2FA.

При выборочном VPN задайте источники WAN через `--ip-discovery-urls 'https://ifconfig.me/ip,https://ipv4-internet.yandex.net/api/v0/ip'`. Сначала сравните их ответы с WAN роутера. После установки environment file также можно редактировать с последующим restart службы. При недоступности выбранных endpoints DNS сохраняется.

## Проверка и обслуживание

systemd:

```sh
systemctl status npm-cloudflare-dns-module
journalctl -u npm-cloudflare-dns-module -n 50
```

OpenRC:

```sh
rc-service npm-cloudflare-dns-module status
tail -n 50 /var/log/npm-cloudflare-dns-module.log
```

Из новой версии каталога проекта выполните `sudo python3 scripts/install-linux.py --upgrade` для обновления активного модуля. Установщик проверяет синтаксис новых исходников до замены и перезапускает службу; token, флаги, environment и NPM сохраняются. Обновление самого NPM проводится его штатным способом с последующей проверкой API, вкладки Settings и listeners.

Для отключения: `sudo python3 scripts/install-linux.py --uninstall`. Служба останавливается и отключается от автозапуска, исходный listener NPM восстанавливается с `nginx -t` и reload. Данные модуля, резервные копии, файлы службы и DNS-записи сохраняются. Если nginx-файл изменён после установки, автоматический откат отказывается затирать новые правки: нужно вернуть только административный listener вручную. `--upgrade` не запускает модуль, ранее отключённый через `--uninstall`.

## Границы проверки

Native-установщик испытан с настоящим nginx и OpenRC в изолированной Linux-среде, включая restart и uninstall. В тесте нет реальных Cloudflare credentials. systemd unit проверяется отдельными тестами генерации; запуск на полноценном systemd-хосте пока не проверен. Контракты интерфейса/API те же, что у Docker NPM: новая версия NPM может потребовать обновления адаптера.

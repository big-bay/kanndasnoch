#!/usr/bin/env bash
set -euo pipefail

archive=/root/kanndasnoch-publisher.tar
app_dir=/opt/kanndasnoch-publisher
runtime_dir=/var/lib/kanndasnoch-publisher
service_user=kanndasnoch-publisher
stamp=$(date +%Y%m%d-%H%M%S)
stage_dir="/opt/.kanndasnoch-publisher-stage-${stamp}"

test -f "$archive"
test -f /etc/kanndasnoch-publisher.env
test "$(stat -c %a /etc/kanndasnoch-publisher.env)" = 600

if ! id "$service_user" >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$runtime_dir" --shell /usr/sbin/nologin "$service_user"
fi

install -d -m 0755 /opt
install -d -o "$service_user" -g "$service_user" -m 0700 "$runtime_dir"
install -d -m 0755 "$stage_dir"
trap 'rm -rf -- "$stage_dir"' EXIT
tar -xf "$archive" -C "$stage_dir"

cd "$stage_dir"
npm ci --omit=dev
npm run check

chown -R root:root "$stage_dir"
find "$stage_dir" -type d -exec chmod 0755 {} +
find "$stage_dir" -type f -exec chmod 0644 {} +

if [ -d "$app_dir" ]; then
  mv "$app_dir" "${app_dir}.backup-${stamp}"
fi
mv "$stage_dir" "$app_dir"
trap - EXIT

install -o root -g root -m 0644 "$app_dir/deploy/kanndasnoch-publisher.service" /etc/systemd/system/kanndasnoch-publisher.service
systemctl daemon-reload
systemctl enable --now kanndasnoch-publisher.service
systemctl is-active --quiet kanndasnoch-publisher.service
curl --fail --silent --show-error --retry 10 --retry-all-errors --retry-delay 1 http://127.0.0.1:8787/api/v1/health

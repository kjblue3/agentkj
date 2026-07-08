#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

APP_DIR="$(realpath "${1:-$(pwd)}")"
APP_USER="${APP_USER:-${SUDO_USER:-}}"

if [[ -z "${APP_USER}" || "${APP_USER}" == "root" ]]; then
  echo "Set APP_USER to the non-root account that owns the checkout." >&2
  exit 1
fi
APP_GROUP="$(id -gn "${APP_USER}")"

if [[ ! -f "${APP_DIR}/package.json" || ! -f "${APP_DIR}/deploy/oci/slack-detective.service" ]]; then
  echo "${APP_DIR} is not a Slack Detective checkout." >&2
  exit 1
fi

if ! command -v apt-get >/dev/null; then
  echo "This installer requires the Ubuntu 24.04 ARM64 image." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl debian-keyring debian-archive-keyring apt-transport-https git gnupg python3

PUBLIC_IP="${PUBLIC_IP:-}"
if [[ -z "${PUBLIC_IP}" ]]; then
  METADATA="$(
    curl --noproxy "*" -fsS --connect-timeout 3 \
      -H "Authorization: Bearer Oracle" \
      http://169.254.169.254/opc/v2/vnics/ 2>/dev/null || true
  )"
  PUBLIC_IP="$(
    python3 -c 'import json,sys
try:
    vnics=json.load(sys.stdin)
    print(next((v.get("publicIp") for v in vnics if v.get("publicIp")), ""))
except Exception:
    print("")' <<<"${METADATA}"
  )"
fi

PUBLIC_HOST="${PUBLIC_HOST:-}"
if [[ -z "${PUBLIC_HOST}" && -n "${PUBLIC_IP}" ]]; then
  PUBLIC_HOST="${PUBLIC_IP//./-}.sslip.io"
fi
if [[ -z "${PUBLIC_HOST}" ]]; then
  echo "Could not discover a public IP. Re-run with PUBLIC_HOST set to a DNS name." >&2
  exit 1
fi

if ! command -v node >/dev/null || [[ "$(node --version | tr -d v | cut -d. -f1)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    -o /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  chmod o+r /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

install -d -m 700 -o "${APP_USER}" -g "${APP_GROUP}" /var/lib/slack-detective

runuser -u "${APP_USER}" -- npm --prefix "${APP_DIR}" ci
runuser -u "${APP_USER}" -- npm --prefix "${APP_DIR}" run build

if [[ ! -f /etc/slack-detective.env ]]; then
  sed "s|__PUBLIC_BASE_URL__|https://${PUBLIC_HOST}|g" \
    "${APP_DIR}/deploy/oci/slack-detective.env.example" \
    > /etc/slack-detective.env
elif grep -q '^PUBLIC_BASE_URL=' /etc/slack-detective.env; then
  sed -i "s|^PUBLIC_BASE_URL=.*$|PUBLIC_BASE_URL=https://${PUBLIC_HOST}|" \
    /etc/slack-detective.env
else
  printf '\nPUBLIC_BASE_URL=https://%s\n' "${PUBLIC_HOST}" >> /etc/slack-detective.env
fi
chown root:"${APP_GROUP}" /etc/slack-detective.env
chmod 640 /etc/slack-detective.env

sed \
  -e "s|__APP_USER__|${APP_USER}|g" \
  -e "s|__APP_DIR__|${APP_DIR}|g" \
  "${APP_DIR}/deploy/oci/slack-detective.service" \
  > /etc/systemd/system/slack-detective.service

sed "s|__PUBLIC_HOST__|${PUBLIC_HOST}|g" \
  "${APP_DIR}/deploy/oci/Caddyfile" \
  > /etc/caddy/Caddyfile

systemctl daemon-reload
systemctl enable --now caddy slack-detective
systemctl restart caddy slack-detective

echo
echo "Installed Slack Detective at https://${PUBLIC_HOST}"
echo "Add secrets with: sudoedit /etc/slack-detective.env"
echo "Then restart with: sudo systemctl restart slack-detective"

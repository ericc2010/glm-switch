#!/usr/bin/env bash
# Install glm-switch on the head Spark: the command in ~/bin, the page in ~/glm-switch-web, the service glm-switch-web.
#   ./install.sh            install or update (keeps an existing config)
# Needs root for the systemd unit: ROOT_CMD from the config ("sudo -n" or bin/rootsh).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
CONF=$HOME/.config/glm-switch/config.env
WEBDIR=$HOME/glm-switch-web

if [[ ! -f "$CONF" ]]; then
  mkdir -p "$(dirname "$CONF")" && cp "$HERE/config.example.env" "$CONF"
  echo "Wrote $CONF from the example: fill in this cluster's values, then run ./install.sh again."; exit 1
fi
source "$CONF"
install -Dm755 "$HERE/bin/glm-switch" "$HOME/bin/glm-switch"
install -Dm755 "$HERE/web/glm-switch-web.py" "$WEBDIR/glm-switch-web.py"
install -Dm644 "$HERE/web/glm-switch-web.html" "$WEBDIR/glm-switch-web.html"
sed -e "s|@USER@|$(id -un)|" -e "s|@WEBDIR@|$WEBDIR|g" "$HERE/systemd/glm-switch-web.service" > /tmp/glm-switch-web.service
${ROOT_CMD:-sudo -n} sh -c "install -m644 /tmp/glm-switch-web.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable glm-switch-web && systemctl restart glm-switch-web"
rm -f /tmp/glm-switch-web.service
echo "Installed. Status: $HOME/bin/glm-switch status · page: http://<this host>:${WEB_PORT:-8891}/"

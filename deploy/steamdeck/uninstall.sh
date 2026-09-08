#!/usr/bin/env bash
# SteamOS / Linux 제거 스크립트. 기기 정보와 전송 기록(설정 폴더)은 남겨 둔다.
set -euo pipefail

APP_ID="steam-file-transfer"
INSTALL_DIR="$HOME/.local/share/$APP_ID"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/$APP_ID"

info() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }

info "서비스 중지 및 해제"
systemctl --user disable --now "$APP_ID.service" 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/$APP_ID.service"
systemctl --user daemon-reload 2>/dev/null || true

info "파일 삭제"
rm -rf "$INSTALL_DIR"
rm -f "$HOME/.local/bin/$APP_ID"
rm -f "$HOME/.local/share/applications/$APP_ID.desktop"
rm -f "$HOME/.local/share/icons/hicolor/256x256/apps/$APP_ID.png"

if [[ -d "$CONFIG_DIR/backups" ]]; then
  info "기기 정보와 전송 기록은 남겨 둡니다: $CONFIG_DIR"
  echo "    완전히 지우려면: rm -rf \"$CONFIG_DIR\""
else
  rm -rf "$CONFIG_DIR"
fi

info "제거 완료"

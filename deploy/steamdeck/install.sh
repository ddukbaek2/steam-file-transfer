#!/usr/bin/env bash
# SteamOS / Linux 자동 설치 스크립트
#
# 하는 일:
#   1. 앱 파일을 ~/.local/share/steam-file-transfer 로 복사
#   2. systemd 사용자 서비스 등록 + 부팅 시 자동 시작 (lingering)
#   3. 방화벽이 켜져 있으면 필요한 포트를 자동으로 개방
#   4. 데스크톱 아이콘 등록
#
# SteamOS 는 루트 파티션이 읽기 전용이므로 홈 디렉터리에만 설치한다.
# steamos-readonly 를 해제하거나 pacman 을 쓰지 않기 때문에 시스템 업데이트에도 살아남는다.

set -euo pipefail

APP_ID="steam-file-transfer"
APP_NAME="Steam File Transfer"
HTTP_PORT="${SFT_HTTP_PORT:-37021}"
DISCOVERY_PORT="${SFT_DISCOVERY_PORT:-37020}"

INSTALL_DIR="$HOME/.local/share/$APP_ID"
BIN_DIR="$HOME/.local/bin"
SERVICE_DIR="$HOME/.config/systemd/user"
DESKTOP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

info() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$1"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$1" >&2; exit 1; }

# --- 1. 앱 파일 찾기 -----------------------------------------------------
# 배포 tar.gz 안에서는 스크립트가 resources/steamdeck/ 에 있고, 앱 루트는 두 단계 위다.
# 실행 권한(-x)이 아니라 존재(-f)로 찾는다. Windows 에서 만든 tar.gz 는
# 실행 비트를 잃기 때문에 -x 로 찾으면 여기서 바로 실패한다. 권한은 복사 후 다시 부여한다.
find_app_root() {
  local d="$SRC_DIR"
  for _ in 1 2 3 4; do
    if [[ -f "$d/$APP_ID" ]]; then echo "$d"; return 0; fi
    d="$(dirname "$d")"
  done
  # 배포 압축을 푼 폴더에서 직접 실행한 경우
  for cand in "$SRC_DIR/.." "$SRC_DIR/../.." "$PWD"; do
    if [[ -f "$cand/$APP_ID" ]]; then (cd "$cand" && pwd); return 0; fi
  done
  return 1
}

APP_ROOT="${SFT_APP_ROOT:-$(find_app_root || true)}"
[[ -n "$APP_ROOT" ]] || die "앱 실행 파일($APP_ID)을 찾지 못했습니다. 압축을 푼 폴더에서 실행하세요."
info "앱 위치: $APP_ROOT"

# --- 2. 복사 ------------------------------------------------------------
info "설치 중: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR" "$BIN_DIR" "$SERVICE_DIR" "$DESKTOP_DIR" "$ICON_DIR"
# 기존 설치가 실행 중이면 중지
systemctl --user stop "$APP_ID.service" 2>/dev/null || true
rm -rf "${INSTALL_DIR:?}/"*
cp -a "$APP_ROOT/." "$INSTALL_DIR/"

# Windows 에서 만든 tar.gz 는 실행 권한을 잃는다. 필요한 파일에 직접 다시 부여한다.
chmod +x "$INSTALL_DIR/$APP_ID"
for helper in chrome_crashpad_handler chrome-sandbox; do
  [[ -f "$INSTALL_DIR/$helper" ]] && chmod +x "$INSTALL_DIR/$helper"
done
chmod +x "$INSTALL_DIR"/resources/steamdeck/*.sh 2>/dev/null || true

# chrome-sandbox 는 root 소유 + setuid 여야 제 역할을 한다.
# 안 되면 Electron 이 사용자 네임스페이스 샌드박스로 넘어간다. SteamOS 는 이걸 지원한다.
if [[ -f "$INSTALL_DIR/chrome-sandbox" ]] && sudo -n true 2>/dev/null; then
  sudo -n chown root:root "$INSTALL_DIR/chrome-sandbox" 2>/dev/null || true
  sudo -n chmod 4755 "$INSTALL_DIR/chrome-sandbox" 2>/dev/null || true
fi

ln -sf "$INSTALL_DIR/$APP_ID" "$BIN_DIR/$APP_ID"

# --- 3. 데몬 실행 방식 결정 ---------------------------------------------
# GUI 없이 수신만 하려면 Electron 을 순수 Node 모드로 돌린다 (ELECTRON_RUN_AS_NODE).
# 이러면 화면/그래픽 드라이버 없이도 게임 모드에서 안정적으로 상주한다.
DAEMON_SCRIPT="$INSTALL_DIR/resources/app/dist/daemon.cjs"
if [[ ! -f "$DAEMON_SCRIPT" ]]; then
  DAEMON_SCRIPT="$INSTALL_DIR/resources/app.asar/dist/daemon.cjs"
fi
[[ -f "$DAEMON_SCRIPT" ]] || die "데몬 스크립트를 찾지 못했습니다: $DAEMON_SCRIPT"

# --- 4. systemd 사용자 서비스 -------------------------------------------
info "백그라운드 서비스 등록"
cat > "$SERVICE_DIR/$APP_ID.service" <<SERVICE
[Unit]
Description=$APP_NAME receiver daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=ELECTRON_RUN_AS_NODE=1
ExecStart=$INSTALL_DIR/$APP_ID $DAEMON_SCRIPT
Restart=always
RestartSec=5
# 게임 실행 중 성능 영향을 줄인다
Nice=10
IOSchedulingClass=idle

[Install]
WantedBy=default.target
SERVICE

systemctl --user daemon-reload
systemctl --user enable --now "$APP_ID.service"

# 로그인 없이도 부팅 직후 동작하도록 lingering 활성화 (sudo 필요, 실패해도 진행)
if ! loginctl show-user "$USER" 2>/dev/null | grep -q 'Linger=yes'; then
  if sudo -n true 2>/dev/null; then
    sudo loginctl enable-linger "$USER" && info "부팅 시 자동 시작 활성화"
  else
    warn "부팅 시 자동 시작을 켜려면: sudo loginctl enable-linger $USER"
  fi
fi

# --- 5. 방화벽 개방 ------------------------------------------------------
open_firewall() {
  if command -v firewall-cmd >/dev/null 2>&1 && sudo -n firewall-cmd --state >/dev/null 2>&1; then
    sudo -n firewall-cmd --permanent --add-port="$HTTP_PORT/tcp" >/dev/null 2>&1 || true
    sudo -n firewall-cmd --permanent --add-port="$DISCOVERY_PORT/udp" >/dev/null 2>&1 || true
    sudo -n firewall-cmd --reload >/dev/null 2>&1 || true
    info "firewalld 포트 개방 완료"
    return 0
  fi
  if command -v ufw >/dev/null 2>&1 && sudo -n ufw status 2>/dev/null | grep -q 'Status: active'; then
    sudo -n ufw allow "$HTTP_PORT/tcp" >/dev/null 2>&1 || true
    sudo -n ufw allow "$DISCOVERY_PORT/udp" >/dev/null 2>&1 || true
    info "ufw 포트 개방 완료"
    return 0
  fi
  return 1
}
# SteamOS 는 기본적으로 방화벽이 꺼져 있어 별도 조치가 필요 없다.
open_firewall || info "활성화된 방화벽이 없어 포트 개방을 건너뜁니다"

# --- 6. 데스크톱 항목 ----------------------------------------------------
cat > "$DESKTOP_DIR/$APP_ID.desktop" <<DESKTOP
[Desktop Entry]
Name=$APP_NAME
Comment=내부망 Steam 기기 간 한글패치 전송
Exec=$INSTALL_DIR/$APP_ID %U
Icon=$APP_ID
Terminal=false
Type=Application
Categories=Utility;
StartupWMClass=$APP_ID
DESKTOP
if [[ -f "$INSTALL_DIR/resources/steamdeck/icon.png" ]]; then
  cp "$INSTALL_DIR/resources/steamdeck/icon.png" "$ICON_DIR/$APP_ID.png"
fi
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true

# --- 7. 결과 확인 --------------------------------------------------------
sleep 1
if systemctl --user is-active --quiet "$APP_ID.service"; then
  IP="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | paste -sd, -)"
  info "설치 완료. 수신 대기 중입니다."
  echo
  echo "  기기 이름 : $(hostname)"
  echo "  주소      : ${IP:-알 수 없음}:$HTTP_PORT"
  echo "  상태 확인 : systemctl --user status $APP_ID"
  echo "  로그 보기 : journalctl --user -u $APP_ID -f"
  echo "  중지      : systemctl --user stop $APP_ID"
  echo
  echo "  이제 PC 앱을 켜면 이 기기가 자동으로 목록에 나타납니다."
else
  warn "서비스가 시작되지 않았습니다. 로그를 확인하세요:"
  echo "  journalctl --user -u $APP_ID -n 50 --no-pager"
  exit 1
fi

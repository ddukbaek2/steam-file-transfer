#!/usr/bin/env bash
# Steam File Transfer 원클릭 설치 부트스트랩
#
# Decky Loader 와 같은 방식이다. 사용자는 GitHub 릴리스에서 .desktop 파일 하나를 받아
# 데스크톱 모드에서 더블클릭한다. 그 파일이 이 스크립트를 내려받아 실행하고,
# 이 스크립트는 최신 릴리스 tar.gz 를 받아 안에 든 install.sh 를 돌린다.
#
# 이미 설치되어 있으면 최신 버전으로 갱신한다. 기기 정보와 전송 기록은 그대로 남는다.
#
# 이 파일은 릴리스 자산 steam-file-transfer-installer.sh 로 올라간다 (.github/workflows/release.yml).

set -euo pipefail

# 리포지터리 이름. 공개할 리포지터리 이름과 같아야 하고,
# steam-file-transfer-installer.desktop 의 Exec 줄과도 같아야 한다.
REPO="${SFT_REPO:-ddukbaek2/steam-file-transfer}"

# 워크플로가 버전 없는 이름으로 복사본을 올리므로 고정 URL 로 받을 수 있다.
# GitHub API 를 안 거치니 요청 제한도 없고 jq 도 필요 없다.
ASSET="steam-file-transfer-linux-x64.tar.gz"
# SFT_INSTALL_URL 을 주면 그 주소에서 받는다. 포크나 사내 미러, 그리고 로컬 테스트용이다.
URL="${SFT_INSTALL_URL:-https://github.com/$REPO/releases/latest/download/$ASSET}"

info() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$1" >&2; pause; exit 1; }

# 터미널 창에서 더블클릭으로 실행됐을 때 결과를 읽을 시간을 준다.
# stdin 은 curl 파이프라 /dev/tty 에서 읽어야 한다.
pause() {
  if [[ -t 1 && -r /dev/tty ]]; then
    printf '\nEnter 키를 누르면 창이 닫힙니다.'
    read -r < /dev/tty || true
  fi
}

echo
echo "  Steam File Transfer 설치"
echo "  $REPO 의 최신 릴리스를 내려받습니다."
echo

# --- 사전 점검 -----------------------------------------------------------
case "$(uname -m)" in
  x86_64) ;;
  *) die "x86_64 기기만 지원합니다 (현재: $(uname -m)). Steam Deck 과 Steam Machine 은 모두 x86_64 입니다." ;;
esac
command -v curl >/dev/null 2>&1 || die "curl 이 없습니다."
command -v tar  >/dev/null 2>&1 || die "tar 가 없습니다."

# --- 내려받기 -------------------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

info "내려받는 중: $URL"
if ! curl -fL --progress-bar -o "$TMP/$ASSET" "$URL"; then
  die "내려받지 못했습니다. 인터넷 연결과 릴리스 페이지를 확인하세요: https://github.com/$REPO/releases"
fi

info "압축 푸는 중"
tar xzf "$TMP/$ASSET" -C "$TMP"

APP_DIR="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
INSTALLER="$APP_DIR/resources/steamdeck/install.sh"
[[ -f "$INSTALLER" ]] || die "압축 안에 설치 스크립트가 없습니다: $INSTALLER"

# --- 설치 -----------------------------------------------------------------
# SFT_DRY_RUN=1 이면 내려받기와 압축 풀기까지만 하고 설치는 하지 않는다. 부트스트랩 자체를 검증할 때 쓴다.
if [[ "${SFT_DRY_RUN:-0}" == "1" ]]; then
  info "DRY RUN: 설치 스크립트를 찾았습니다: $INSTALLER"
  exit 0
fi

# tar.gz 가 Windows 에서 만들어졌으면 실행 권한이 없으므로 bash 로 직접 부른다.
info "설치 시작"
echo
if bash "$INSTALLER"; then
  echo
  info "끝났습니다. PC 앱을 켜면 이 기기가 자동으로 목록에 나타납니다."
  echo "    다시 실행하면 최신 버전으로 갱신됩니다."
  echo "    제거: bash ~/.local/share/steam-file-transfer/resources/steamdeck/uninstall.sh"
  pause
else
  die "설치 중 오류가 났습니다. 위 메시지를 확인하세요."
fi

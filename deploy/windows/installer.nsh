; NSIS 커스텀 훅: 설치 시 Windows 방화벽 규칙을 자동 등록하고, 제거 시 정리한다.
; 사용자가 매번 "네트워크 액세스 허용" 팝업을 보지 않도록 사설망 프로파일에만 규칙을 넣는다.

!macro customInstall
  DetailPrint "방화벽 규칙 등록 중..."
  ; 기존 규칙 제거 후 재등록 (경로가 바뀐 재설치 대응)
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Steam File Transfer"'
  Pop $0
  nsExec::Exec 'netsh advfirewall firewall add rule name="Steam File Transfer" dir=in action=allow program="$INSTDIR\steam-file-transfer.exe" enable=yes profile=private,domain'
  Pop $0
  nsExec::Exec 'netsh advfirewall firewall add rule name="Steam File Transfer" dir=in action=allow protocol=UDP localport=37020 profile=private,domain'
  Pop $0
  nsExec::Exec 'netsh advfirewall firewall add rule name="Steam File Transfer" dir=in action=allow protocol=TCP localport=37021 profile=private,domain'
  Pop $0
!macroend

!macro customUnInstall
  DetailPrint "방화벽 규칙 제거 중..."
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Steam File Transfer"'
  Pop $0
!macroend

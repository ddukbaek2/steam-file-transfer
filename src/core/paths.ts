// 설정/전송 기록 디렉터리 경로 (GUI 와 데몬이 동일 경로를 쓰도록 Electron API 대신 직접 계산)
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export function configDir(): string {
  // 테스트나 이식형(portable) 실행에서 설정 위치를 바꿀 수 있게 한다
  const override = process.env.SFT_CONFIG_DIR;
  if (override) return override;
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'steam-file-transfer');
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'steam-file-transfer');
    default:
      return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'steam-file-transfer');
  }
}

export function tempDir(): string {
  const dir = path.join(os.tmpdir(), 'steam-file-transfer');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

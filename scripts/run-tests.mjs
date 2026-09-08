// 테스트 실행기.
//
// 테스트는 설정 폴더에 파일을 만들고 지운다. 그 위치가 사용자의 실제 설정 폴더면
// (%APPDATA%/steam-file-transfer, ~/.config/steam-file-transfer) 진짜 기기 정보와 전송 기록 사이에
// 테스트 찌꺼기가 섞인다. 여기서 격리를 강제해 누가 어떻게 실행하든 안전하게 만든다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const configDir = process.env.SFT_CONFIG_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sft-testcfg-'));
const owned = !process.env.SFT_CONFIG_DIR;

const child = spawn(process.execPath, ['--test', 'tests/**/*.test.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, SFT_CONFIG_DIR: configDir },
});

child.on('exit', (code, signal) => {
  if (owned) fs.rmSync(configDir, { recursive: true, force: true });
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

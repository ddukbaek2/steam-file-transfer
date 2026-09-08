// GUI 스모크 테스트 러너.
//
// `npx electron <script>` 나 npm bin 심(shim)을 거치면 인자가 앱 경로로 전달되지 않고
// package.json 의 main 이 실행되는 경우가 있다. 그러면 진짜 앱이 떠서 그대로 멈춘다.
// 그래서 electron 실행 파일을 직접 찾아서 부른다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const electronBin = require('electron');

const outDir = path.join(projectRoot, 'build', 'smoke');
fs.rmSync(outDir, { recursive: true, force: true });

// 스모크는 진짜 앱을 띄운다. 설정 폴더를 격리하지 않으면 가짜 기기(smoke-peer)로 만든
// 전송 기록이 사용자의 실제 기록에 섞이고, 반대로 실제 기록이 검사 결과를 흔든다.
// 게임 목록은 실제 Steam 을 읽어야 하므로 SFT_STEAM_ROOT 는 건드리지 않는다.
const configDir = process.env.SFT_CONFIG_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sft-smokecfg-'));
const ownedConfig = !process.env.SFT_CONFIG_DIR;

const child = spawn(electronBin, [path.join(projectRoot, 'scripts', 'smoke.mjs')], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: { ...process.env, SFT_CONFIG_DIR: configDir },
});

const timer = setTimeout(() => {
  console.error('스모크 테스트 시간 초과 (300초). 창이 열리지 않았거나 전송이 끝나지 않았습니다.');
  child.kill();
}, 300000);

child.on('exit', (code) => {
  clearTimeout(timer);
  if (ownedConfig) fs.rmSync(configDir, { recursive: true, force: true });
  // Electron 은 Windows 에서 stdout 이 콘솔에 붙지 않아 파일로 남긴 결과를 대신 출력한다
  const report = path.join(outDir, 'report.txt');
  if (fs.existsSync(report)) console.log(fs.readFileSync(report, 'utf8'));
  else console.error(`결과 파일이 없습니다: ${report}`);
  process.exit(code ?? 1);
});

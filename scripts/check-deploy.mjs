// 배포 파일 사전 점검. 빌드 전에 돌려 Windows 에서 흔히 깨지는 것들을 잡는다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

// 1. 셸 스크립트는 LF 여야 한다. CRLF 면 리눅스에서 "bash: \r: command not found" 로 죽는다.
const shellDir = path.join(projectRoot, 'deploy', 'steamdeck');
for (const name of fs.readdirSync(shellDir)) {
  if (!name.endsWith('.sh')) continue;
  const file = path.join(shellDir, name);
  const data = fs.readFileSync(file);
  if (data.includes('\r')) {
    problems.push(`${path.relative(projectRoot, file)} 에 CR 이 있습니다. LF 로 저장하세요.`);
  }
  if (!data.subarray(0, 2).equals(Buffer.from('#!'))) {
    problems.push(`${path.relative(projectRoot, file)} 에 셔뱅이 없습니다.`);
  }
}

// 2. 데몬 스크립트 경로가 install.sh 가 기대하는 위치와 맞는지
const installSh = fs.readFileSync(path.join(shellDir, 'install.sh'), 'utf8');
const expected = 'resources/app/dist/daemon.cjs';
if (!installSh.includes(expected)) {
  problems.push(`install.sh 가 ${expected} 를 가리키지 않습니다. asar 설정과 어긋날 수 있습니다.`);
}

// 3. asar 가 켜지면 위 경로가 깨진다
const builderYml = fs.readFileSync(path.join(projectRoot, 'electron-builder.yml'), 'utf8');
if (!/^asar:\s*false/m.test(builderYml)) {
  problems.push('electron-builder.yml 의 asar 가 false 가 아닙니다. 데몬 스크립트 경로가 깨집니다.');
}

// 4. 설치 스크립트가 실행 권한 없이도 앱을 찾을 수 있어야 한다.
//    Windows 에서 만든 tar.gz 는 실행 비트를 잃으므로 -x 로 찾으면 설치가 바로 실패한다.
if (/if \[\[ -x "\$d\/\$APP_ID" \]\]/.test(installSh)) {
  problems.push('install.sh 가 -x 로 앱을 찾습니다. tar.gz 는 실행 권한을 잃으므로 -f 를 써야 합니다.');
}

// 5. 빌드 산출물이 다 있는지
for (const rel of [
  'dist/main.js',
  'dist/preload.cjs',
  'dist/daemon.cjs',
  'dist/renderer/index.html',
  'dist/renderer/app.js',
  'dist/renderer/styles.css',
]) {
  if (!fs.existsSync(path.join(projectRoot, rel))) {
    problems.push(`빌드 산출물이 없습니다: ${rel} (npm run build 를 먼저 실행하세요)`);
  }
}

// 6. 원클릭 설치 파일 세 개(.desktop, get.sh, 워크플로)가 서로 맞는 이름을 쓰는지.
//    하나만 바꾸면 더블클릭 설치가 조용히 깨진다.
{
  const desktop = fs.readFileSync(path.join(shellDir, 'steam-file-transfer-installer.desktop'), 'utf8');
  const getSh = fs.readFileSync(path.join(shellDir, 'get.sh'), 'utf8');
  const workflow = fs.readFileSync(path.join(projectRoot, '.github', 'workflows', 'release.yml'), 'utf8');

  if (desktop.includes('\r')) problems.push('steam-file-transfer-installer.desktop 에 CR 이 있습니다. LF 로 저장하세요.');
  if (!/^Terminal=true$/m.test(desktop)) problems.push('.desktop 의 Terminal=true 가 없습니다. 진행 상황과 오류가 보이지 않습니다.');

  const desktopRepo = /github\.com\/([^/]+\/[^/]+)\/releases\/latest\/download\/([^\s"]+)/.exec(desktop);
  const shRepo = /REPO="\$\{SFT_REPO:-([^}]+)\}"/.exec(getSh);
  const shAsset = /^ASSET="([^"]+)"/m.exec(getSh);
  if (!desktopRepo) problems.push('.desktop 의 Exec 에 릴리스 다운로드 URL 이 없습니다.');
  if (!shRepo) problems.push('get.sh 에서 REPO 기본값을 찾지 못했습니다.');
  if (desktopRepo && shRepo && desktopRepo[1] !== shRepo[1]) {
    problems.push(`리포지터리 이름이 어긋납니다: .desktop=${desktopRepo[1]}, get.sh=${shRepo[1]}`);
  }
  if (desktopRepo && !workflow.includes(`artifacts/${desktopRepo[2]}`)) {
    problems.push(`.desktop 이 받는 ${desktopRepo[2]} 를 워크플로가 올리지 않습니다.`);
  }
  if (shAsset && !workflow.includes(`release/${shAsset[1]}`)) {
    problems.push(`get.sh 가 받는 ${shAsset[1]} 를 워크플로가 만들지 않습니다.`);
  }
}

// 7. 렌더러가 hidden 속성으로 숨겨지는지. display 를 지정한 클래스가 이를 덮어쓰면
//    앱을 켜자마자 모달이 화면을 가린다.
const css = fs.readFileSync(path.join(projectRoot, 'src', 'renderer', 'styles.css'), 'utf8');
if (!/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css)) {
  problems.push('styles.css 에 [hidden] { display: none !important } 규칙이 없습니다. 모달이 숨겨지지 않습니다.');
}

if (problems.length > 0) {
  console.error('배포 점검 실패:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('배포 점검 통과');

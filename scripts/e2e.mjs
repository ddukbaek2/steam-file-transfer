// 종단 간 검증: 빌드된 데몬을 두 개 띄워 실제 HTTP 로 게임을 통째로 동기화한다.
//
// 단위 테스트는 모듈을 직접 부르지만 이 스크립트는 dist/daemon.cjs 를 별도 프로세스로 실행한다.
// systemd 가 실제로 돌릴 파일이 그것이므로, 번들이 깨졌는지 여기서 걸린다.
//
// 사용법: npm run e2e
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-e2e-'));
const esc = (p) => p.split('\\').join('\\\\');

let failed = false;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${msg}`);
  if (!ok) failed = true;
};

/** 가짜 Steam 라이브러리를 만든다. 실제 설치를 건드리지 않는다. */
function makeSteam(name, appId) {
  const steamRoot = path.join(base, name, 'Steam');
  const gamePath = path.join(steamRoot, 'steamapps', 'common', 'DemoGame');
  fs.mkdirSync(gamePath, { recursive: true });
  fs.writeFileSync(path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'),
    `"libraryfolders" { "0" { "path" "${esc(steamRoot)}" } }`);
  fs.writeFileSync(path.join(steamRoot, 'steamapps', `appmanifest_${appId}.acf`),
    `"AppState" { "appid" "${appId}" "name" "DemoGame" "installdir" "DemoGame" }`);
  return { steamRoot, gamePath };
}

function spawnDaemon(label, cfgDir, steamRoot, httpPort) {
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    deviceId: `id-${label}`, deviceName: label, port: httpPort,
    discoveryPort: 45999, password: '', steamRoot, autoStart: false,
  }));
  const child = fork(path.join(projectRoot, 'dist', 'daemon.cjs'), [], {
    env: { ...process.env, SFT_CONFIG_DIR: cfgDir, SFT_STEAM_ROOT: steamRoot },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`  [${label}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`  [${label}!] ${d}`));
  return child;
}

const daemonPath = path.join(projectRoot, 'dist', 'daemon.cjs');
if (!fs.existsSync(daemonPath)) {
  console.error(`데몬 번들이 없습니다: ${daemonPath}\nnpm run build 를 먼저 실행하세요.`);
  process.exit(1);
}

// A: 패치가 적용된(한글) 기기, B: 원본(영어) 기기
const A = makeSteam('deviceA', '900');
const B = makeSteam('deviceB', '900');
fs.mkdirSync(path.join(A.gamePath, 'Data'), { recursive: true });
fs.writeFileSync(path.join(A.gamePath, 'Data', 'Text.loc'), '한글 번역본');
fs.writeFileSync(path.join(A.gamePath, 'shared.bin'), 'IDENTICAL');
fs.writeFileSync(path.join(A.gamePath, 'newfont.ttf'), 'FONT-DATA');
fs.mkdirSync(path.join(B.gamePath, 'data'), { recursive: true }); // 소문자 폴더: 대소문자 보정 확인용
fs.writeFileSync(path.join(B.gamePath, 'data', 'text.loc'), 'ENGLISH TEXT');
fs.writeFileSync(path.join(B.gamePath, 'shared.bin'), 'IDENTICAL');
fs.mkdirSync(path.join(B.gamePath, 'saves'), { recursive: true });
fs.writeFileSync(path.join(B.gamePath, 'saves', 'slot1.sav'), '소중한 세이브');

const a = spawnDaemon('deviceA', path.join(base, 'cfgA'), A.steamRoot, 45001);
const b = spawnDaemon('deviceB', path.join(base, 'cfgB'), B.steamRoot, 45002);

/** 고정 대기는 부하가 걸린 기기에서 모자란다. 실제로 응답할 때까지 기다린다. */
async function waitReady(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch { /* 아직 안 떴다 */ }
    if (Date.now() > deadline) throw new Error(`데몬이 뜨지 않았습니다: 포트 ${port}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

try {
  await Promise.all([waitReady(45001), waitReady(45002)]);
} catch (e) {
  console.error(e.message);
  a.kill(); b.kill();
  fs.rmSync(base, { recursive: true, force: true });
  process.exit(1);
}

const testable = path.join(projectRoot, 'dist-test', 'testable.mjs');
if (!fs.existsSync(testable)) {
  console.error(`테스트 번들이 없습니다: ${testable}\nnode scripts/build-tests.mjs 를 먼저 실행하세요.`);
  a.kill(); b.kill();
  process.exit(1);
}
const { PeerClient, planTransfer, executeTransfer, RemoteTarget, RemoteSource } = await import(pathToFileURL(testable).href);

try {
  const clientA = new PeerClient('127.0.0.1', 45001);
  const clientB = new PeerClient('127.0.0.1', 45002);
  const peerA = { ...(await clientA.info()), address: '127.0.0.1', port: 45001, lastSeen: Date.now(), self: false };
  const peerB = { ...(await clientB.info()), address: '127.0.0.1', port: 45002, lastSeen: Date.now(), self: false };

  console.log('\n[1] 기기 정보와 게임 목록');
  check(peerB.name === 'deviceB', `기기 이름: ${peerB.name}`);
  const games = await clientB.games();
  check(games.length === 1 && games[0].appId === '900', `게임 ${games.length}개 (${games[0]?.name})`);

  console.log('\n[2] A 의 게임을 B 로 통째로 동기화 (이 프로세스가 중계: A 에서 읽어 B 에 쓴다)');
  const target = { key: 'b', adapter: new RemoteTarget(peerB), appId: '900', root: 'game' };
  const plan = await planTransfer({ source: new RemoteSource(peerA), sourceAppId: '900', sourceRoot: 'game', targets: [target], onlyExisting: false });
  const tp = plan.targets[0];
  check(tp.skippedSame === 1, `동일 해시 건너뜀 ${tp.skippedSame}개 (shared.bin)`);
  check(tp.newFiles === 1, `새 파일 ${tp.newFiles}개 (newfont.ttf)`);
  check(tp.toSend.length === 2, `전송 대상 ${tp.toSend.length}개: ${tp.toSend.map((f) => f.relPath).join(', ')}`);

  const events = [];
  const r = await executeTransfer({ plan, adapters: new Map([['b', target]]), onEvent: (e) => events.push(e) });
  check(r.files === 2 && r.failed === 0, `전송 성공 ${r.files}개, 실패 ${r.failed}개`);
  check(r.committed === 2 && r.commitFailed === 0, `교체 ${r.committed}개`);
  check(r.verify && r.verify.same === 3 && r.verify.differ === 0, `검증: 동일 ${r.verify?.same}개, 다름 ${r.verify?.differ}개`);
  check(events.some((e) => e.kind === 'committing') && events.some((e) => e.kind === 'verifying'), '교체/검증 단계 이벤트가 나옴');

  console.log('\n[3] 대소문자 보정: B 의 소문자 data/text.loc 이 교체되고 중복 폴더가 없어야 함');
  const gameDir = fs.readdirSync(B.gamePath);
  check(gameDir.includes('data') && !gameDir.includes('Data'), `게임 폴더: ${gameDir.join(', ')}`);
  check(fs.readFileSync(path.join(B.gamePath, 'data', 'text.loc'), 'utf8') === '한글 번역본', '내용 교체됨');
  check(fs.readFileSync(path.join(B.gamePath, 'newfont.ttf'), 'utf8') === 'FONT-DATA', '새 파일 생성됨');
  check(!fs.existsSync(path.join(B.steamRoot, 'steamapps', '.sft-staging', '900-game', tp.sessionId)), '임시 폴더 정리됨');

  console.log('\n[4] 수신 현황 API 에 완료가 기록되었는지');
  const st = await clientB.status();
  check(st.inbound.length >= 1 && st.inbound[0].state === 'done', `수신 현황: ${st.inbound[0]?.state} (${st.inbound[0]?.message})`);

  console.log('\n[5] 폴더를 파일로 덮어쓰려는 시도를 거부하는지');
  const evil = Buffer.from('폴더를 지우려는 파일');
  const { createHash } = await import('node:crypto');
  const { Readable } = await import('node:stream');
  const evilItem = { relPath: 'saves', size: evil.length, sha256: createHash('sha256').update(evil).digest('hex') };
  const s = await clientB.openSession('900', 'game', [evilItem], false);
  let rejected = '';
  try {
    await clientB.stageFile('900', 'game', s.sessionId, 'saves', evil.length, evilItem.sha256, Readable.from([evil]));
  } catch (e) { rejected = e.message; }
  check(rejected.includes('같은 이름의 폴더'), `거부됨: ${rejected}`);
  check(fs.existsSync(path.join(B.gamePath, 'saves', 'slot1.sav')), '세이브 파일이 그대로 있음');

  console.log('\n[6] 같은 게임을 다시 보내면 전송할 게 없어야 함');
  const plan2 = await planTransfer({ source: new RemoteSource(peerA), sourceAppId: '900', sourceRoot: 'game', targets: [target], onlyExisting: false });
  check(plan2.targets[0].toSend.length === 0, `두 번째 계획 대상 ${plan2.targets[0].toSend.length}개`);
} catch (e) {
  console.error('\n예외:', e);
  failed = true;
} finally {
  a.kill();
  b.kill();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(base, { recursive: true, force: true });
}

console.log(failed ? '\n=== 실패 ===' : '\n=== 전부 통과 ===');
process.exit(failed ? 1 : 0);

// TransferNode 의 기동 모드 판정 검증.
// 데몬이 이미 포트를 잡고 있을 때 GUI 가 어떻게 동작하는지가 핵심이다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const mod = await import('../dist-test/testable.mjs');
const { TransferNode } = mod;

const sandboxes = [];
function sandbox() {
  // macOS 의 os.tmpdir() 은 /private 아래를 가리키는 심볼릭 링크다.
  // 코드가 실제 경로를 돌려주므로 기대값도 실제 경로여야 한다.
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sft-node-')));
  sandboxes.push(d);
  return d;
}

process.on('exit', () => {
  for (const d of sandboxes) fs.rmSync(d, { recursive: true, force: true });
});

/** 지정한 설정으로 노드를 만든다. 설정 디렉터리를 바꿔 서로 다른 기기처럼 다룬다. */
function makeNode(cfgDir, cfg) {
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(cfg));
  const prev = process.env.SFT_CONFIG_DIR;
  process.env.SFT_CONFIG_DIR = cfgDir;
  try {
    return new TransferNode();
  } finally {
    process.env.SFT_CONFIG_DIR = prev;
  }
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test('노드: 포트가 비어 있으면 수신 서버가 된다', async (t) => {
  const port = await freePort();
  const cfgDir = sandbox();
  const node = makeNode(cfgDir, {
    deviceId: 'solo', deviceName: '단독기기', port,
    discoveryPort: await freePort(), password: '', steamRoot: '',
  });
  t.after(() => node.stop());

  const status = await node.start();
  assert.equal(status.mode, 'serving');
  assert.match(status.message, /수신 대기 중/);

  // 실제로 응답하는지 확인
  const res = await fetch(`http://127.0.0.1:${port}/api/info`);
  assert.equal(res.status, 200);
  const info = await res.json();
  assert.equal(info.name, '단독기기');
});

test('노드: 같은 기기의 데몬이 이미 떠 있으면 백그라운드 수신 중으로 본다', async (t) => {
  const port = await freePort();
  const cfgDir = sandbox();
  const cfg = {
    deviceId: 'shared-id', deviceName: '덱', port,
    discoveryPort: await freePort(), password: '', steamRoot: '',
  };

  // 데몬 역할
  const daemon = makeNode(cfgDir, cfg);
  t.after(() => daemon.stop());
  const daemonStatus = await daemon.start();
  assert.equal(daemonStatus.mode, 'serving');

  // 같은 설정으로 GUI 를 켠 상황 (deviceId 가 같다)
  const gui = makeNode(cfgDir, cfg);
  t.after(() => gui.stop());
  const guiStatus = await gui.start();

  assert.equal(guiStatus.mode, 'daemon-running', 'GUI 는 데몬이 도는 것을 알아채야 한다');
  assert.match(guiStatus.message, /백그라운드/);
});

test('노드: 남의 프로그램이 포트를 쓰면 보내기 전용이 된다', async (t) => {
  const port = await freePort();
  // 우리 API 가 아닌 서버가 그 포트를 점유
  const squatter = net.createServer((s) => s.end());
  await new Promise((r) => squatter.listen(port, '0.0.0.0', r));
  t.after(() => squatter.close());

  const cfgDir = sandbox();
  const node = makeNode(cfgDir, {
    deviceId: 'blocked', deviceName: '막힌기기', port,
    discoveryPort: await freePort(), password: '', steamRoot: '',
  });
  t.after(() => node.stop());

  const status = await node.start();
  assert.equal(status.mode, 'client-only');
  assert.match(status.message, /다른 프로그램/);
});

test('노드: 설정을 바꾸면 저장되고 광고 내용에 반영된다', async (t) => {
  const cfgDir = sandbox();
  const node = makeNode(cfgDir, {
    deviceId: 'cfg', deviceName: '이전이름', port: await freePort(),
    discoveryPort: await freePort(), password: '', steamRoot: '',
  });
  t.after(() => node.stop());

  assert.equal(node.selfInfo().requiresPassword, false);

  const prev = process.env.SFT_CONFIG_DIR;
  process.env.SFT_CONFIG_DIR = cfgDir;
  try {
    node.updateConfig({ deviceName: '새이름', password: 'pw' });
  } finally {
    process.env.SFT_CONFIG_DIR = prev;
  }

  assert.equal(node.selfInfo().name, '새이름');
  assert.equal(node.selfInfo().requiresPassword, true, '암호를 걸면 광고에 표시되어야 한다');

  const saved = JSON.parse(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8'));
  assert.equal(saved.deviceName, '새이름');
  assert.equal(saved.password, 'pw');
});

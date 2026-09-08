// 실제 HTTP 서버와 UDP 탐색을 띄워 종단 간 동작을 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

const mod = await import('../dist-test/testable.mjs');
const {
  createServer, PeerClient, Discovery, InboundTracker,
  planTransfer, executeTransfer, RemoteTarget, RemoteSource, LocalTarget, LocalSource,
} = mod;

const sandboxes = [];
function sandbox() {
  // macOS 의 os.tmpdir() 은 /private 아래를 가리키는 심볼릭 링크다.
  // 코드가 실제 경로를 돌려주므로 기대값도 실제 경로여야 한다.
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sft-net-')));
  sandboxes.push(d);
  return d;
}
function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}
function sha(c) { return createHash('sha256').update(c).digest('hex'); }
function item(relPath, content) {
  const b = Buffer.from(content);
  return { relPath, size: b.length, sha256: sha(b) };
}

process.on('exit', () => {
  for (const d of sandboxes) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * 임시 Steam 라이브러리를 만들고 SFT_STEAM_ROOT 로 그것만 보게 한다.
 * 게임 여러 개를 한 라이브러리에 둘 수 있다. 실제 설치를 건드리지 않는다.
 */
function fakeLibrary(games) {
  const home = sandbox();
  const steamRoot = path.join(home, 'Steam');
  fs.mkdirSync(path.join(steamRoot, 'steamapps', 'common'), { recursive: true });
  write(path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'),
    `"libraryfolders" { "0" { "path" "${steamRoot.split('\\').join('\\\\')}" } }`);
  const out = { steamRoot, paths: {} };
  for (const [appId, name] of games) {
    const gamePath = path.join(steamRoot, 'steamapps', 'common', name);
    fs.mkdirSync(gamePath, { recursive: true });
    write(path.join(steamRoot, 'steamapps', `appmanifest_${appId}.acf`),
      `"AppState" { "appid" "${appId}" "name" "${name}" "installdir" "${name}" }`);
    out.paths[appId] = gamePath;
  }
  process.env.SFT_STEAM_ROOT = steamRoot;
  process.env.SFT_STEAM_ROOT = steamRoot;
  return out;
}

async function startServer(opts) {
  const inbound = new InboundTracker();
  const server = createServer({
    config: () => opts.config,
    self: () => opts.self,
    log: opts.log ?? (() => {}),
    inbound,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, inbound };
}

const SELF = {
  id: 'test-device', name: '테스트 수신기', os: 'linux',
  hostname: 'testhost', version: '0.1.0', port: 0, requiresPassword: false,
};
const cfg = (password = '') => ({ deviceId: 'x', deviceName: 'x', port: 0, discoveryPort: 0, password, steamRoot: '', autoStart: false });

test('HTTP: 세션 열기 → 임시 폴더로 받기 → 교체 → 검증이 순서대로 동작한다', async (t) => {
  const lib = fakeLibrary([['480', 'TestGame']]);
  const { server, port, inbound } = await startServer({ config: cfg(), self: { ...SELF } });
  t.after(() => server.close());
  const game = lib.paths['480'];
  const client = new PeerClient('127.0.0.1', port);

  const info = await client.info();
  assert.equal(info.id, 'test-device');
  const games = await client.games();
  assert.equal(games.length, 1);
  assert.equal(games[0].gamePath, game);

  // 원본: 대문자 경로의 영어 파일 + 동일한 파일 하나
  write(path.join(game, 'Data', 'Text.loc'), 'ENGLISH');
  write(path.join(game, 'same.bin'), 'SAME');
  const files = [item('data/text.loc', '한국어 번역'), item('same.bin', 'SAME'), item('New/font.ttf', 'FONT')];

  const session = await client.openSession('480', 'game', files, false);
  assert.equal(session.alreadySame, 1, '동일 파일은 받지 않는다');
  assert.equal(session.newFiles, 1);
  assert.deepEqual(session.needed.sort(), ['New/font.ttf', 'data/text.loc']);

  // 아직 게임 폴더는 그대로여야 한다
  for (const rel of session.needed) {
    const f = files.find((x) => x.relPath === rel);
    await client.stageFile('480', 'game', session.sessionId, rel, f.size, f.sha256, Readable.from([Buffer.from(rel === 'same.bin' ? 'SAME' : rel === 'data/text.loc' ? '한국어 번역' : 'FONT')]));
  }
  assert.equal(fs.readFileSync(path.join(game, 'Data', 'Text.loc'), 'utf8'), 'ENGLISH', '교체 전에는 원본 그대로');
  assert.equal(fs.existsSync(path.join(game, 'New')), false);

  // 수신 현황에 잡혔는지
  const inb = inbound.list();
  assert.equal(inb.length, 1);
  assert.equal(inb[0].received, 2);
  assert.equal(inb[0].state, 'receiving');

  const commit = await client.commit('480', 'game', session.sessionId);
  assert.equal(commit.applied, 2);
  assert.equal(commit.failed.length, 0);
  assert.equal(fs.readFileSync(path.join(game, 'Data', 'Text.loc'), 'utf8'), '한국어 번역');
  assert.deepEqual(fs.readdirSync(path.join(game, 'Data')), ['Text.loc'], '대소문자 보정으로 중복 없음');
  assert.equal(fs.readFileSync(path.join(game, 'New', 'font.ttf'), 'utf8'), 'FONT');
  assert.equal(inbound.list()[0].state, 'done');

  // 임시 폴더는 정리되고 게임 폴더 안에는 흔적이 없다
  assert.equal(fs.existsSync(path.join(lib.steamRoot, 'steamapps', '.sft-staging', '480-game', session.sessionId)), false);
  assert.equal(fs.readdirSync(game).includes('.sft-staging'), false);

  const verify = await client.check('480', 'game', files);
  assert.ok(verify.every((r) => r.same), '검증에서 전부 동일');
});

test('HTTP: 중간에 끊겨도 게임 폴더는 멀쩡하고 다음 세션이 이어받는다', async (t) => {
  const lib = fakeLibrary([['481', 'ResumeGame']]);
  const { server, port } = await startServer({ config: cfg(), self: { ...SELF } });
  t.after(() => server.close());
  const game = lib.paths['481'];
  write(path.join(game, 'a.dat'), 'OLD A');
  write(path.join(game, 'b.dat'), 'OLD B');
  const files = [item('a.dat', 'NEW A'), item('b.dat', 'NEW B')];
  const client = new PeerClient('127.0.0.1', port);

  const s1 = await client.openSession('481', 'game', files, false);
  assert.equal(s1.needed.length, 2);
  // a 만 받고 "끊김"
  await client.stageFile('481', 'game', s1.sessionId, 'a.dat', files[0].size, files[0].sha256, Readable.from([Buffer.from('NEW A')]));
  assert.equal(fs.readFileSync(path.join(game, 'a.dat'), 'utf8'), 'OLD A', '교체하지 않았으므로 원본 유지');

  // 다시 시도: 같은 원본이면 같은 세션 ID 로 이어받는다
  const s2 = await client.openSession('481', 'game', files, false);
  assert.equal(s2.sessionId, s1.sessionId);
  assert.equal(s2.alreadyStaged, 1, 'a 는 이미 받아 두었다');
  assert.deepEqual(s2.needed, ['b.dat']);

  await client.stageFile('481', 'game', s2.sessionId, 'b.dat', files[1].size, files[1].sha256, Readable.from([Buffer.from('NEW B')]));
  const r = await client.commit('481', 'game', s2.sessionId);
  assert.equal(r.applied, 2);
  assert.equal(fs.readFileSync(path.join(game, 'a.dat'), 'utf8'), 'NEW A');
  assert.equal(fs.readFileSync(path.join(game, 'b.dat'), 'utf8'), 'NEW B');
});

test('HTTP: 잘못된 해시는 임시 폴더에도 남지 않고 원본은 그대로다', async (t) => {
  const lib = fakeLibrary([['482', 'HashGame']]);
  const { server, port } = await startServer({ config: cfg(), self: { ...SELF } });
  t.after(() => server.close());
  const game = lib.paths['482'];
  const target = write(path.join(game, 'keep.bin'), 'ORIGINAL');
  const client = new PeerClient('127.0.0.1', port);
  const bad = Buffer.from('corrupted');
  const files = [{ relPath: 'keep.bin', size: bad.length, sha256: sha('something-else') }];
  const s = await client.openSession('482', 'game', files, false);
  await assert.rejects(
    client.stageFile('482', 'game', s.sessionId, 'keep.bin', bad.length, files[0].sha256, Readable.from([bad])),
    /무결성 검사 실패/,
  );
  assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL');
  const staged = path.join(lib.steamRoot, 'steamapps', '.sft-staging', '482-game', s.sessionId, 'files');
  assert.deepEqual(fs.existsSync(staged) ? fs.readdirSync(staged) : [], []);
});

test('HTTP: 폴더를 파일로 덮어쓰려는 시도는 받기 전에 거부한다', async (t) => {
  const lib = fakeLibrary([['483', 'SafeGame']]);
  const { server, port } = await startServer({ config: cfg(), self: { ...SELF } });
  t.after(() => server.close());
  const game = lib.paths['483'];
  write(path.join(game, 'saves', 'slot1.sav'), '소중한 세이브');
  const client = new PeerClient('127.0.0.1', port);
  const files = [item('saves', '폴더를 지우려는 파일')];
  const s = await client.openSession('483', 'game', files, false);
  await assert.rejects(
    client.stageFile('483', 'game', s.sessionId, 'saves', files[0].size, files[0].sha256, Readable.from([Buffer.from('폴더를 지우려는 파일')])),
    /같은 이름의 폴더/,
  );
  assert.equal(fs.readFileSync(path.join(game, 'saves', 'slot1.sav'), 'utf8'), '소중한 세이브');
  // 상위 경로 탈출도
  const evil = item('../../escaped.txt', 'evil');
  const s2 = await client.openSession('483', 'game', [evil], false).catch((e) => e);
  if (!(s2 instanceof Error)) {
    await assert.rejects(client.stageFile('483', 'game', s2.sessionId, '../../escaped.txt', evil.size, evil.sha256, Readable.from([Buffer.from('evil')])), /잘못된 경로|500/);
  }
  assert.equal(fs.existsSync(path.join(lib.steamRoot, 'steamapps', 'escaped.txt')), false);
});

test('HTTP: 암호가 설정되면 헤더 없이는 401, 틀리면 다른 문구', async (t) => {
  fakeLibrary([['484', 'AuthGame']]);
  const { server, port } = await startServer({ config: cfg('secret'), self: { ...SELF, requiresPassword: true } });
  t.after(() => server.close());
  const anon = new PeerClient('127.0.0.1', port);
  const info = await anon.info();
  assert.equal(info.requiresPassword, true);
  await assert.rejects(anon.games(), /암호가 필요합니다/);
  await assert.rejects(new PeerClient('127.0.0.1', port, 'wrong').games(), /암호가 맞지 않습니다/);
  const authed = new PeerClient('127.0.0.1', port, 'secret');
  assert.equal((await authed.games()).length, 1);
  // status 는 암호 없이도 (같은 기기의 화면이 데몬 현황을 볼 때)
  const st = await anon.status();
  assert.ok(Array.isArray(st.inbound));
});

test('HTTP: tree 와 file 로 상대 기기의 게임 폴더를 읽을 수 있다 (받기)', async (t) => {
  const lib = fakeLibrary([['485', 'PullGame']]);
  const { server, port } = await startServer({ config: cfg(), self: { ...SELF } });
  t.after(() => server.close());
  const game = lib.paths['485'];
  write(path.join(game, 'Data', 'Text.loc'), '한국어');
  write(path.join(game, 'bin', 'game.exe'), 'EXE');
  // 임시 폴더 흔적이 목록에 섞이면 안 된다
  write(path.join(lib.steamRoot, 'steamapps', '.sft-staging', 'x', 'junk'), 'junk');

  const client = new PeerClient('127.0.0.1', port);
  const tree = await client.tree('485', 'game');
  assert.deepEqual(tree.files.map((f) => f.relPath).sort(), ['Data/Text.loc', 'bin/game.exe']);
  const stream = await client.download('485', 'game', 'Data/Text.loc');
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  assert.equal(Buffer.concat(chunks).toString('utf8'), '한국어');
  await assert.rejects(client.download('485', 'game', 'nope.txt'), /파일이 없습니다/);
  assert.equal(await client.icon('485'), null, '가짜 게임에는 아이콘이 없다');
});

test('전송: 보내기(RemoteTarget)와 받기(RemoteSource)가 같은 코드로 동작한다', async (t) => {
  // 700: 패치가 적용된 원본 게임, 701: 받을 게임 (같은 라이브러리, 같은 프로세스)
  const lib = fakeLibrary([['700', 'SrcGame'], ['701', 'DstGame']]);
  const { server, port } = await startServer({ config: cfg(), self: { ...SELF } });
  t.after(() => server.close());
  const src = lib.paths['700'];
  const dst = lib.paths['701'];
  write(path.join(src, 'a.pak'), 'PATCHED A');
  write(path.join(src, 'sub', 'b.pak'), 'PATCHED B');
  write(path.join(src, 'same.pak'), 'SAME');
  write(path.join(dst, 'same.pak'), 'SAME');
  const peer = { ...SELF, address: '127.0.0.1', port, lastSeen: Date.now(), self: false };

  // 보내기: 이 기기(700) → 원격(701)
  const sendTarget = { key: 'r', adapter: new RemoteTarget(peer), appId: '701', root: 'game' };
  const plan = await planTransfer({ source: new LocalSource(), sourceAppId: '700', sourceRoot: 'game', targets: [sendTarget], onlyExisting: false });
  assert.equal(plan.targets[0].skippedSame, 1);
  assert.equal(plan.targets[0].toSend.length, 2);
  const events = [];
  const r = await executeTransfer({ plan, adapters: new Map([['r', sendTarget]]), onEvent: (e) => events.push(e) });
  assert.equal(r.files, 2);
  assert.equal(r.committed, 2);
  assert.equal(r.verify.same, 3, '검증: 원본 3개 전부 동일');
  assert.ok(events.some((e) => e.kind === 'committing'));
  assert.ok(events.some((e) => e.kind === 'verifying'));
  assert.equal(fs.readFileSync(path.join(dst, 'sub', 'b.pak'), 'utf8'), 'PATCHED B');

  // 받기: 원격(700) → 이 기기(701). 이미 같으므로 0개 전송
  const pullTarget = { key: 'l', adapter: new LocalTarget(), appId: '701', root: 'game' };
  const plan2 = await planTransfer({ source: new RemoteSource(peer), sourceAppId: '700', sourceRoot: 'game', targets: [pullTarget], onlyExisting: false });
  assert.equal(plan2.targets[0].toSend.length, 0);

  // 원본이 바뀌면 받기가 그것만 가져온다
  write(path.join(src, 'a.pak'), 'PATCHED A v2');
  const plan3 = await planTransfer({ source: new RemoteSource(peer), sourceAppId: '700', sourceRoot: 'game', targets: [pullTarget], onlyExisting: false });
  assert.deepEqual(plan3.targets[0].toSend.map((f) => f.relPath), ['a.pak']);
  const r3 = await executeTransfer({ plan: plan3, adapters: new Map([['l', pullTarget]]), onEvent: () => {} });
  assert.equal(r3.committed, 1);
  assert.equal(fs.readFileSync(path.join(dst, 'a.pak'), 'utf8'), 'PATCHED A v2');
});

test('전송: 파일 하나라도 못 받으면 교체하지 않는다', async (t) => {
  const lib = fakeLibrary([['710', 'PartialSrc'], ['711', 'PartialDst']]);
  const { server, port } = await startServer({ config: cfg(), self: { ...SELF } });
  t.after(() => server.close());
  const src = lib.paths['710'];
  const dst = lib.paths['711'];
  write(path.join(src, 'ok.pak'), 'OK');
  write(path.join(src, 'gone.pak'), 'GONE');
  write(path.join(dst, 'ok.pak'), 'OLD');
  const peer = { ...SELF, address: '127.0.0.1', port, lastSeen: Date.now(), self: false };
  const target = { key: 'r', adapter: new RemoteTarget(peer), appId: '711', root: 'game' };
  const plan = await planTransfer({ source: new LocalSource(), sourceAppId: '710', sourceRoot: 'game', targets: [target], onlyExisting: false });
  // 계획 뒤에 원본 파일 하나가 사라진다 (USB 분리, 백신 격리 등)
  fs.rmSync(path.join(src, 'gone.pak'));
  const r = await executeTransfer({ plan, adapters: new Map([['r', target]]), onEvent: () => {} });
  assert.equal(r.failed, 1);
  assert.equal(r.committed, 0, '하나라도 못 받았으면 교체하지 않는다');
  assert.equal(fs.readFileSync(path.join(dst, 'ok.pak'), 'utf8'), 'OLD', '게임 폴더는 그대로');
});

test('탐색: 두 노드가 서로를 자동으로 발견한다', async (t) => {
  const port = 41000 + Math.floor(Math.random() * 2000);
  const a = { id: 'node-a', name: '기기 A', os: 'windows', hostname: 'a', version: '0.1.0', port: 1, requiresPassword: false };
  const b = { id: 'node-b', name: '기기 B', os: 'steamos', hostname: 'b', version: '0.1.0', port: 2, requiresPassword: true };
  const da = new Discovery(port, () => a);
  const db = new Discovery(port, () => b);
  t.after(() => { da.stop(); db.stop(); });
  await da.start();
  await db.start();
  db.announce(1);
  const seen = await new Promise((resolve) => {
    const deadline = Date.now() + 6000;
    const tick = () => {
      const pa = da.list();
      const pb = db.list();
      if ((pa.length > 0 && pb.length > 0) || Date.now() > deadline) resolve({ pa, pb });
      else setTimeout(tick, 150);
    };
    tick();
  });
  assert.equal(seen.pa[0]?.id, 'node-b');
  assert.equal(seen.pa[0]?.requiresPassword, true);
  assert.equal(seen.pb[0]?.id, 'node-a');
  assert.ok(!seen.pa.some((p) => p.id === 'node-a'));
});

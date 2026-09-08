// 핵심 로직 테스트. esbuild 로 번들한 테스트 진입점을 통해 TS 소스를 그대로 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

const mod = await import('../dist-test/testable.mjs');
const {
  parseVdf, vdfObject, vdfString,
  safeRelPath, resolveCaseInsensitive, createDirCache, expandSelection,
  readLibraryFolders, readLibraryGames,
  checkFiles, receiveFile,
  openSession, stageFile, commitSession, sessionIdFor,
  planTransfer, executeTransfer,
  sha256File, hashTree, configDir,
} = mod;

const sandboxes = [];
function sandbox() {
  // macOS 의 os.tmpdir() 은 /private 아래를 가리키는 심볼릭 링크다.
  // 코드가 실제 경로를 돌려주므로 기대값도 실제 경로여야 한다.
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sft-test-')));
  sandboxes.push(d);
  return d;
}
function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}
function sha(content) {
  return createHash('sha256').update(content).digest('hex');
}

process.on('exit', () => {
  for (const d of sandboxes) fs.rmSync(d, { recursive: true, force: true });
});

// --- VDF 파서 ----------------------------------------------------------
test('VDF: 중첩 객체와 이스케이프 경로를 읽는다', () => {
  const text = `
"libraryfolders"
{
  "0"
  {
    "path"    "C:\\\\Program Files (x86)\\\\Steam"
    "label"   ""
    "apps"
    {
      "440"  "12345"
    }
  }
  // 주석 줄
  "1"
  {
    "path"    "/run/media/mmcblk0p1"
  }
}`;
  const root = parseVdf(text);
  const lf = vdfObject(root, 'libraryfolders');
  assert.ok(lf);
  assert.equal(vdfString(vdfObject(lf, '0'), 'path'), 'C:\\Program Files (x86)\\Steam');
  assert.equal(vdfString(vdfObject(lf, '1'), 'path'), '/run/media/mmcblk0p1');
  assert.equal(vdfString(vdfObject(vdfObject(lf, '0'), 'apps'), '440'), '12345');
});

test('VDF: 키 조회는 대소문자를 가리지 않는다', () => {
  const root = parseVdf('"AppState" { "AppID" "620" "Name" "Portal 2" }');
  const s = vdfObject(root, 'appstate');
  assert.equal(vdfString(s, 'appid'), '620');
  assert.equal(vdfString(s, 'NAME'), 'Portal 2');
});

// --- Steam 라이브러리 --------------------------------------------------
test('Steam: libraryfolders 와 appmanifest 로 게임 목록을 만든다', () => {
  const root = sandbox();
  const lib2 = path.join(root, 'sdcard');
  write(path.join(root, 'steamapps', 'libraryfolders.vdf'),
    `"libraryfolders"\n{\n "0" { "path" "${root.replace(/\\/g, '\\\\')}" }\n "1" { "path" "${lib2.replace(/\\/g, '\\\\')}" }\n}`);
  fs.mkdirSync(path.join(root, 'steamapps', 'common', 'Portal 2'), { recursive: true });
  write(path.join(root, 'steamapps', 'appmanifest_620.acf'),
    '"AppState" { "appid" "620" "name" "Portal 2" "installdir" "Portal 2" "SizeOnDisk" "1024" }');
  // 설치 폴더가 없는 항목은 제외되어야 한다
  write(path.join(root, 'steamapps', 'appmanifest_999.acf'),
    '"AppState" { "appid" "999" "name" "Ghost" "installdir" "Ghost" }');
  fs.mkdirSync(lib2, { recursive: true });

  const libs = readLibraryFolders(root);
  assert.ok(libs.includes(root));
  assert.ok(libs.includes(lib2));

  const games = readLibraryGames(root);
  assert.equal(games.length, 1);
  assert.equal(games[0].name, 'Portal 2');
  assert.equal(games[0].appId, '620');
  assert.equal(games[0].sizeOnDisk, 1024);
  assert.equal(games[0].gamePath, path.join(root, 'steamapps', 'common', 'Portal 2'));
});

test('Steam: 매니페스트 없이 폴더만 남은 것은 목록에서 뺀다 (Steam 이 설치된 것으로 아는 게임만)', () => {
  const root = sandbox();
  fs.mkdirSync(path.join(root, 'steamapps', 'common', 'Portal 2'), { recursive: true });
  // 지운 게임이 남긴 잔여물: 로그 하나뿐인 폴더
  write(path.join(root, 'steamapps', 'common', 'LeftoverGame', 'debug.log'), 'x');
  write(path.join(root, 'steamapps', 'common', 'notes.txt'), 'x'); // 파일은 게임이 아니다
  write(path.join(root, 'steamapps', 'appmanifest_620.acf'),
    '"AppState" { "appid" "620" "name" "Portal 2" "installdir" "Portal 2" }');
  // 손상된 매니페스트는 건너뛴다
  write(path.join(root, 'steamapps', 'appmanifest_777.acf'), '"AppState" { "appid" "777" ');

  const games = readLibraryGames(root);
  assert.deepEqual(games.map((g) => g.name), ['Portal 2']);
  assert.equal(games[0].appId, '620');
});

// --- 경로 안전성 -------------------------------------------------------
test('경로: 상위 탈출을 거부하고 구분자를 통일한다', () => {
  assert.equal(safeRelPath('a\\b/c.txt'), 'a/b/c.txt');
  assert.equal(safeRelPath('./a//b'), 'a/b');
  assert.throws(() => safeRelPath('../etc/passwd'), /잘못된 경로/);
  assert.throws(() => safeRelPath('a/../../b'), /잘못된 경로/);
});

test('경로: 중간 폴더까지 실제 철자로 되돌린다', () => {
  const base = sandbox();
  const real = write(path.join(base, 'Data', 'Fonts', 'Main.ttf'), 'x');
  const r = resolveCaseInsensitive(base, 'data/fonts/main.ttf');
  assert.equal(r.exists, true);
  // 상위 폴더 철자까지 디스크와 정확히 일치해야 한다 (SteamOS 에서 중복 파일 방지)
  assert.equal(r.fullPath, real);

  const r2 = resolveCaseInsensitive(base, 'data/fonts/NEW.ttf');
  assert.equal(r2.exists, false);
  assert.equal(r2.fullPath, path.join(base, 'Data', 'Fonts', 'NEW.ttf'));

  const r3 = resolveCaseInsensitive(base, 'nope/deep/file.bin');
  assert.equal(r3.exists, false);
  assert.equal(r3.fullPath, path.join(base, 'nope', 'deep', 'file.bin'));
});

test('디렉터리 캐시: 같은 결과를 돌려주고 읽기 횟수를 줄인다', () => {
  const base = sandbox();
  write(path.join(base, 'Sub', 'A.txt'), 'a');
  write(path.join(base, 'Sub', 'B.txt'), 'b');
  const cache = createDirCache();
  const a = resolveCaseInsensitive(base, 'sub/a.txt', cache);
  const b = resolveCaseInsensitive(base, 'sub/b.txt', cache);
  assert.equal(a.fullPath, path.join(base, 'Sub', 'A.txt'));
  assert.equal(b.fullPath, path.join(base, 'Sub', 'B.txt'));
  assert.equal(cache.size, 2);
});

test('선택 확장: 폴더를 재귀적으로 펼치고 임시 폴더와 메타 파일은 뺀다', () => {
  const base = sandbox();
  write(path.join(base, 'a', 'x.txt'), '1');
  write(path.join(base, 'a', 'sub', 'y.txt'), '22');
  write(path.join(base, 'b.txt'), '333');
  write(path.join(base, '.DS_Store'), 'junk');
  write(path.join(base, '.sft-staging', 'abc', 'files', 'z.txt'), 'staged');

  const all = expandSelection(base, []);
  assert.deepEqual(all.files.map((f) => f.relPath), ['a/sub/y.txt', 'a/x.txt', 'b.txt']);
  const tree = expandSelection(base, ['a', 'a/x.txt']);
  assert.deepEqual(tree.files.map((f) => f.relPath), ['a/sub/y.txt', 'a/x.txt']);
});

test('hashTree: 폴더 전체의 해시 목록을 만든다', async () => {
  const base = sandbox();
  write(path.join(base, 'a.bin'), 'AAA');
  write(path.join(base, 'd', 'b.bin'), 'BB');
  const t = await hashTree(base);
  assert.deepEqual(t.files.map((f) => [f.relPath, f.size, f.sha256]), [
    ['a.bin', 3, sha('AAA')],
    ['d/b.bin', 2, sha('BB')],
  ]);
  assert.deepEqual(t.unreadable, []);
});

// --- 해시 비교 / 덮어쓰기 ----------------------------------------------
test('checkFiles: 존재 여부와 해시 동일 여부를 구분한다', async () => {
  const base = sandbox();
  write(path.join(base, 'same.txt'), 'hello');
  write(path.join(base, 'diff.txt'), 'old');
  const items = [
    { relPath: 'same.txt', size: 5, sha256: sha('hello') },
    { relPath: 'diff.txt', size: 5, sha256: sha('hello') },
    { relPath: 'new.txt', size: 5, sha256: sha('hello') },
  ];
  const res = await checkFiles(base, items);
  assert.deepEqual(res.map((r) => [r.relPath, r.exists, r.same]), [
    ['same.txt', true, true],
    ['diff.txt', true, false],
    ['new.txt', false, false],
  ]);
});

test('receiveFile: 해시 검증 후 대소문자만 다른 기존 파일을 덮어쓴다', async () => {
  const base = sandbox();
  const target = write(path.join(base, 'Data', 'text.loc'), 'ENGLISH');
  const content = Buffer.from('한국어');

  const r = await receiveFile({
    base,
    relPath: 'data/text.loc', // 대소문자가 다름
    sha256: sha(content), size: content.length,
    stream: Readable.from([content]),
  });
  assert.equal(r.written, true);
  assert.equal(r.replaced, true);
  assert.equal(r.resolvedPath, target);
  assert.equal(fs.readFileSync(target, 'utf8'), '한국어');
  assert.equal(fs.readdirSync(path.join(base, 'Data')).length, 1, '중복 파일이 생기지 않는다');
});

test('receiveFile: 해시가 다르면 원본을 건드리지 않는다', async () => {
  const base = sandbox();
  const target = write(path.join(base, 'keep.txt'), 'ORIGINAL');
  const content = Buffer.from('tampered');
  await assert.rejects(
    receiveFile({
      base,
      relPath: 'keep.txt',
      sha256: sha(Buffer.from('expected-something-else')), size: content.length,
      stream: Readable.from([content]),
    }),
    /무결성 검사 실패/,
  );
  assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL');
  assert.deepEqual(fs.readdirSync(base), ['keep.txt']);
});


// --- 세션 (임시 폴더에 받아 두었다가 한 번에 교체) --------------------------
/** stagingRoot 가 <library>/steamapps/.sft-staging 를 쓰므로 실제 구조를 흉내 낸다 */
function fakeLibraryGame(appId, name) {
  const lib = sandbox();
  const base = path.join(lib, 'steamapps', 'common', name);
  fs.mkdirSync(base, { recursive: true });
  return { base, lib, game: { appId, name, installDir: name, libraryPath: lib, gamePath: base, sizeOnDisk: 0 } };
}
function sourceOf(base) {
  return {
    label: '원본',
    async game() { return { appId: 's', name: '원본 게임', installDir: 'src', libraryPath: base, gamePath: base, sizeOnDisk: 0 }; },
    async list() { return hashTree(base); },
    async open(_a, _r, rel) { return fs.createReadStream(path.join(base, ...rel.split('/'))); },
  };
}
function targetOf(g, name) {
  return {
    label: name,
    async game() { return g; },
    async openSession(_a, _r, files, onlyExisting) { return openSession(g, 'game', files, onlyExisting); },
    async stage(_a, _r, sessionId, relPath, size, sha256, stream) { await stageFile(g, 'game', sessionId, relPath, sha256, size, stream); },
    async commit(_a, _r, sessionId) { return commitSession(g, 'game', sessionId); },
    async check(_a, _r, files) { return checkFiles(g.gamePath, files); },
  };
}

test('sessionIdFor: 파일 목록이 같으면 순서가 달라도 같은 ID, 내용이 다르면 다른 ID', () => {
  const a = [{ relPath: 'a', size: 1, sha256: 'x' }, { relPath: 'b', size: 2, sha256: 'y' }];
  const b = [a[1], a[0]];
  assert.equal(sessionIdFor(a), sessionIdFor(b));
  assert.notEqual(sessionIdFor(a), sessionIdFor([{ relPath: 'a', size: 1, sha256: 'z' }, a[1]]));
  assert.match(sessionIdFor(a), /^[0-9a-f]{16}$/);
});

test('세션: 임시 폴더에 받아 두었다가 commit 에서만 게임 폴더를 바꾼다', async () => {
  const src = sandbox();
  const { base: dst, lib, game } = fakeLibraryGame('900', 'DemoGame');
  write(path.join(src, 'same.txt'), 'AAA');
  write(path.join(src, 'changed.txt'), 'NEW');
  write(path.join(src, 'added.txt'), 'ADD');
  write(path.join(dst, 'same.txt'), 'AAA');
  write(path.join(dst, 'changed.txt'), 'OLD');

  const target = { key: 'k', adapter: targetOf(game, '대상'), appId: '900', root: 'game' };
  const plan = await planTransfer({ source: sourceOf(src), sourceAppId: 's', sourceRoot: 'game', targets: [target], onlyExisting: false });
  const t = plan.targets[0];
  assert.equal(t.skippedSame, 1);
  assert.equal(t.newFiles, 1);
  assert.deepEqual(t.toSend.map((f) => f.relPath).sort(), ['added.txt', 'changed.txt']);
  assert.match(t.sessionId, /^[0-9a-f]{16}$/);
  // 세션을 열기만 해서는 게임 폴더가 바뀌지 않는다
  assert.equal(fs.readFileSync(path.join(dst, 'changed.txt'), 'utf8'), 'OLD');

  const events = [];
  const r = await executeTransfer({ plan, adapters: new Map([['k', target]]), onEvent: (e) => events.push(e) });
  assert.equal(r.files, 2);
  assert.equal(r.committed, 2);
  assert.equal(r.commitFailed, 0);
  assert.deepEqual(r.verify, { same: 3, differ: 0, missing: 0 });
  assert.equal(fs.readFileSync(path.join(dst, 'changed.txt'), 'utf8'), 'NEW');
  assert.equal(fs.readFileSync(path.join(dst, 'added.txt'), 'utf8'), 'ADD');
  assert.deepEqual(events.map((e) => e.kind).filter((k) => k !== 'file'), ['start', 'committing', 'verifying', 'done']);
  // 임시 폴더는 정리되고 게임 폴더 안에는 흔적이 없다
  assert.equal(fs.existsSync(path.join(lib, 'steamapps', '.sft-staging', '900-game', t.sessionId)), false);
  assert.equal(fs.readdirSync(dst).includes('.sft-staging'), false);
});

test('세션: onlyExisting 이면 대상에 없는 파일은 제외한다 (교집합)', async () => {
  const src = sandbox();
  const { base: dst, game } = fakeLibraryGame('901', 'OnlyExisting');
  write(path.join(src, 'changed.txt'), 'NEW');
  write(path.join(src, 'added.txt'), 'ADD');
  write(path.join(dst, 'changed.txt'), 'OLD');
  const target = { key: 'k', adapter: targetOf(game, '대상'), appId: '901', root: 'game' };
  const plan = await planTransfer({ source: sourceOf(src), sourceAppId: 's', sourceRoot: 'game', targets: [target], onlyExisting: true });
  assert.equal(plan.targets[0].skippedMissing, 1);
  assert.deepEqual(plan.targets[0].toSend.map((f) => f.relPath), ['changed.txt']);
});

test('세션: 중단하면 게임 폴더는 그대로고 다음 시도가 이어받는다', async () => {
  const src = sandbox();
  const { base: dst, game } = fakeLibraryGame('902', 'AbortGame');
  write(path.join(src, 'a.pak'), Buffer.alloc(300000, 1));
  write(path.join(src, 'b.pak'), Buffer.alloc(300000, 2));
  write(path.join(src, 'c.pak'), Buffer.alloc(300000, 3));
  write(path.join(dst, 'a.pak'), 'OLD');

  const target = { key: 'k', adapter: targetOf(game, '대상'), appId: '902', root: 'game' };
  const plan = await planTransfer({ source: sourceOf(src), sourceAppId: 's', sourceRoot: 'game', targets: [target], onlyExisting: false });
  const ctrl = new AbortController();
  let completed = 0;
  const r = await executeTransfer({
    plan, adapters: new Map([['k', target]]), signal: ctrl.signal,
    onEvent: (e) => { if (e.kind === 'file' && e.doneBytes - (e.index - 1) * 300000 >= e.bytes && ++completed === 1) ctrl.abort(); },
  });
  assert.equal(r.committed, 0, '중단됐으면 교체하지 않는다');
  assert.equal(fs.readFileSync(path.join(dst, 'a.pak'), 'utf8'), 'OLD');
  assert.ok(r.files >= 1);

  const plan2 = await planTransfer({ source: sourceOf(src), sourceAppId: 's', sourceRoot: 'game', targets: [target], onlyExisting: false });
  assert.equal(plan2.targets[0].sessionId, plan.targets[0].sessionId, '같은 원본이면 같은 세션으로 이어받는다');
  assert.ok(plan2.targets[0].alreadyStaged >= 1);
  assert.equal(plan2.targets[0].toSend.length + plan2.targets[0].alreadyStaged, 3);
  const r2 = await executeTransfer({ plan: plan2, adapters: new Map([['k', target]]), onEvent: () => {} });
  assert.equal(r2.committed, 3);
  assert.equal(fs.readFileSync(path.join(dst, 'a.pak')).length, 300000);
});

test('세션: 잠긴 파일처럼 일부 교체가 실패하면 나머지는 임시 폴더에 남긴다', async () => {
  const { base: dst, lib, game } = fakeLibraryGame('904', 'LockedGame');
  // 대상에 'data' 가 폴더로 있고 원본에는 같은 이름의 파일이 있다 → 교체 단계에서 거부된다
  fs.mkdirSync(path.join(dst, 'data'), { recursive: true });
  const files = [
    { relPath: 'ok.txt', size: 2, sha256: sha('OK') },
    { relPath: 'data', size: 3, sha256: sha('BAD') },
  ];
  const s = await openSession(game, 'game', files, false);
  await stageFile(game, 'game', s.sessionId, 'ok.txt', files[0].sha256, 2, Readable.from([Buffer.from('OK')]));
  // stage 단계가 먼저 거부한다
  await assert.rejects(stageFile(game, 'game', s.sessionId, 'data', files[1].sha256, 3, Readable.from([Buffer.from('BAD')])), /같은 이름의 폴더/);
  const r = await commitSession(game, 'game', s.sessionId);
  assert.equal(r.applied, 1);
  assert.equal(fs.readFileSync(path.join(dst, 'ok.txt'), 'utf8'), 'OK');
  assert.ok(fs.existsSync(path.join(dst, 'data')), '폴더는 살아 있다');
  // 전부 성공했으므로 세션은 정리된다 (거부된 파일은 애초에 받지 않았다)
  assert.equal(fs.existsSync(path.join(lib, 'steamapps', '.sft-staging', '904-game', s.sessionId)), false);
});

test('planTransfer: 대상 조회가 실패하면 원인 오류를 그대로 보여주고 다른 대상은 진행한다', async () => {
  const src = sandbox();
  write(path.join(src, 'a.txt'), 'A');
  const { game } = fakeLibraryGame('903', 'GoodGame');
  const bad = {
    key: 'bad', appId: '1', root: 'game',
    adapter: {
      label: '잠긴기기',
      async game() { throw new Error('암호가 필요합니다'); },
      async openSession() { throw new Error('x'); },
      async stage() { throw new Error('x'); },
      async commit() { throw new Error('x'); },
      async check() { return []; },
    },
  };
  const good = { key: 'good', adapter: targetOf(game, '정상'), appId: '903', root: 'game' };
  const plan = await planTransfer({ source: sourceOf(src), sourceAppId: 's', sourceRoot: 'game', targets: [bad, good], onlyExisting: false });
  // "설치되어 있지 않습니다" 로 뭉개지 말고 진짜 원인이 보여야 한다
  assert.equal(plan.targets[0].error, '암호가 필요합니다');
  assert.equal(plan.targets[1].toSend.length, 1);
});

// --- 기타 ------------------------------------------------------------------
test('sha256File: 스트리밍 해시가 일치한다', async () => {
  const base = sandbox();
  const p = write(path.join(base, 'x.bin'), Buffer.alloc(300000, 7));
  assert.equal(await sha256File(p), sha(Buffer.alloc(300000, 7)));
});

test('configDir: 환경 변수가 있으면 그것을, 없으면 플랫폼 기본 경로를 쓴다', () => {
  const prev = process.env.SFT_CONFIG_DIR;
  process.env.SFT_CONFIG_DIR = path.join(os.tmpdir(), 'sft-override-check');
  assert.equal(configDir(), path.join(os.tmpdir(), 'sft-override-check'));
  try {
    delete process.env.SFT_CONFIG_DIR;
    const d = configDir();
    assert.ok(path.isAbsolute(d), `절대 경로여야 한다: ${d}`);
    assert.ok(d.includes('steam-file-transfer'), `앱 이름이 들어가야 한다: ${d}`);
  } finally {
    if (prev === undefined) delete process.env.SFT_CONFIG_DIR;
    else process.env.SFT_CONFIG_DIR = prev;
  }
});

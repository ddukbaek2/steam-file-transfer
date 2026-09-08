// 게임 폴더를 망가뜨리지 않기 위한 안전장치 검증.
// 검토에서 실제로 재현된 시나리오들을 그대로 테스트로 남긴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

const mod = await import('../dist-test/testable.mjs');
const { receiveFile, resolveWriteTarget, expandSelection } = mod;

const sandboxes = [];
function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-safe-'));
  sandboxes.push(d);
  return d;
}
function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}
function sha(c) { return createHash('sha256').update(c).digest('hex'); }

function put(base, relPath, content) {
  const buf = Buffer.from(content);
  return receiveFile({ base, relPath, sha256: sha(buf), size: buf.length, stream: Readable.from([buf]) });
}

process.on('exit', () => {
  for (const d of sandboxes) fs.rmSync(d, { recursive: true, force: true });
});

// --- 폴더를 파일로 덮어쓰기 ---------------------------------------------
test('폴더를 파일로 덮어쓰려 하면 거부하고 트리를 지킨다', async () => {
  const base = sandbox();
  write(path.join(base, 'data', 'save1.dat'), '소중한 세이브');
  write(path.join(base, 'data', 'nested', 'save2.dat'), '더 소중한 세이브');

  await assert.rejects(put(base, 'data', '패치 파일'), /같은 이름의 폴더/);

  assert.equal(fs.readFileSync(path.join(base, 'data', 'save1.dat'), 'utf8'), '소중한 세이브');
  assert.equal(fs.readFileSync(path.join(base, 'data', 'nested', 'save2.dat'), 'utf8'), '더 소중한 세이브');
  assert.deepEqual(fs.readdirSync(base), ['data'], '임시 파일도 남지 않는다');
});

test('대소문자만 다른 폴더도 파일로 덮어쓰지 않는다', async () => {
  const base = sandbox();
  write(path.join(base, 'Data', 'save.dat'), '세이브');
  await assert.rejects(put(base, 'data', '패치'), /같은 이름의 폴더/);
  assert.equal(fs.readFileSync(path.join(base, 'Data', 'save.dat'), 'utf8'), '세이브');
});

test('경로 중간에 파일이 있으면 원시 오류 대신 설명을 준다', async () => {
  const base = sandbox();
  write(path.join(base, 'data'), '이건 파일이다');
  await assert.rejects(put(base, 'data/x.pak', '내용'), /경로 중간에 같은 이름의 파일/);
  assert.equal(fs.readFileSync(path.join(base, 'data'), 'utf8'), '이건 파일이다');
});

// --- 심볼릭 링크 -------------------------------------------------------
test('게임 폴더 밖을 가리키는 링크는 거부한다', async (t) => {
  const base = sandbox();
  const outside = sandbox();
  fs.mkdirSync(path.join(base, 'users'), { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(base, 'users', 'Documents'), 'junction');
  } catch {
    t.skip('이 환경에서는 심볼릭 링크를 만들 수 없습니다');
    return;
  }
  await assert.rejects(put(base, 'users/Documents/evil.exe', '나쁜 파일'), /게임 폴더 밖/);
  assert.deepEqual(fs.readdirSync(outside), [], '바깥 폴더가 비어 있어야 한다');
});

test('경로 중간의 링크도 게임 폴더 밖이면 거부한다', async (t) => {
  const base = sandbox();
  const outside = sandbox();
  try {
    fs.symlinkSync(outside, path.join(base, 'mid'), 'junction');
  } catch {
    t.skip('이 환경에서는 심볼릭 링크를 만들 수 없습니다');
    return;
  }
  assert.throws(() => resolveWriteTarget(base, 'mid/deep/evil.exe'), /게임 폴더 밖/);
  await assert.rejects(put(base, 'mid/deep/evil.exe', '나쁜 파일'), /게임 폴더 밖/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('게임 폴더 안을 가리키는 링크는 링크를 유지한 채 쓴다', async (t) => {
  const base = sandbox();
  const realFile = write(path.join(base, 'real', 'text.loc'), 'ENGLISH');
  fs.mkdirSync(path.join(base, 'alias'), { recursive: true });
  try {
    fs.symlinkSync(realFile, path.join(base, 'alias', 'text.loc'), 'file');
  } catch {
    t.skip('이 환경에서는 심볼릭 링크를 만들 수 없습니다');
    return;
  }
  const r = await put(base, 'alias/text.loc', '한국어');
  assert.equal(fs.readFileSync(realFile, 'utf8'), '한국어', '링크가 가리키는 실제 파일이 바뀌어야 한다');
  assert.equal(r.resolvedPath, fs.realpathSync(realFile));
  assert.equal(fs.lstatSync(path.join(base, 'alias', 'text.loc')).isSymbolicLink(), true);
});

test('게임 폴더 자체가 링크여도 안에 정확히 쓴다', async (t) => {
  const real = sandbox();
  const linkParent = sandbox();
  const base = path.join(linkParent, 'gameLink');
  try {
    fs.symlinkSync(real, base, 'junction');
  } catch {
    t.skip('이 환경에서는 심볼릭 링크를 만들 수 없습니다');
    return;
  }
  write(path.join(real, 'text.loc'), '원본');
  await put(base, 'text.loc', '패치');
  assert.equal(fs.readFileSync(path.join(real, 'text.loc'), 'utf8'), '패치');
  assert.deepEqual(fs.readdirSync(real), ['text.loc'], '임시 파일이 남지 않는다');
});

// --- 무결성 -------------------------------------------------------------
test('실패해도 게임 폴더에 임시 파일을 남기지 않는다', async () => {
  const base = sandbox();
  write(path.join(base, 'keep.dat'), '원본');
  const buf = Buffer.from('내용');
  await assert.rejects(
    receiveFile({ base, relPath: 'keep.dat', sha256: sha(Buffer.from('다른 값')), size: buf.length, stream: Readable.from([buf]) }),
    /무결성 검사 실패/,
  );
  assert.deepEqual(fs.readdirSync(base), ['keep.dat']);
  assert.equal(fs.readFileSync(path.join(base, 'keep.dat'), 'utf8'), '원본');
});

test('resolveWriteTarget: 기존 파일과 새 파일을 구분하고 상대 경로는 실제 철자다', () => {
  const base = sandbox();
  write(path.join(base, 'A', 'B', 'c.pak'), 'x');
  const r = resolveWriteTarget(base, 'a/b/c.pak');
  assert.equal(r.existsAsFile, true);
  assert.equal(r.fullPath, path.join(base, 'A', 'B', 'c.pak'));
  assert.equal(r.diskRel, 'A/B/c.pak');

  const n = resolveWriteTarget(base, 'New/File.pak');
  assert.equal(n.existsAsFile, false);
  assert.equal(n.diskRel, 'New/File.pak');
});

// --- 목록 만들기 -------------------------------------------------------
test('폴더 링크를 따라가지 않아 목록이 폭발하지 않는다', async (t) => {
  const base = sandbox();
  write(path.join(base, 'sub', 'a.txt'), '내용');
  try {
    fs.symlinkSync(base, path.join(base, 'sub', 'loop'), 'junction');
  } catch {
    t.skip('이 환경에서는 심볼릭 링크를 만들 수 없습니다');
    return;
  }
  const r = expandSelection(base, []);
  assert.equal(r.files.length, 1, `파일 하나만 나와야 한다: ${r.files.map((f) => f.relPath).join(', ')}`);
  assert.equal(r.files[0].relPath, 'sub/a.txt');
  assert.ok(r.skipped.some((s) => s.reason.includes('폴더 링크')), '건너뛴 이유를 알려야 한다');
});

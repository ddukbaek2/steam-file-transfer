// 수신(Target) 측: 세션 열기 → 임시 폴더에 받기 → 한 번에 교체
//
// 이 파일은 남의 게임 파일을 지우고 새로 쓰는 곳이다. 여기서 실수하면 복구가 안 되므로
// 다음을 지킨다.
//   1. 파일은 게임 폴더에 곧바로 쓰지 않는다. 같은 볼륨의 임시 폴더에 전부 받은 뒤 rename 으로 교체한다.
//      무선이 중간에 끊겨도 게임 폴더는 멀쩡하고, 다음 시도는 이미 받아 둔 파일을 건너뛴다.
//   2. 조금이라도 이상하면 (폴더를 파일로 덮어쓰기, 게임 폴더 밖을 가리키는 심볼릭 링크 등) 쓰지 않고 거부한다.
//
// 원본 백업은 하지 않는다. 원래 상태로 돌리는 것은 Steam 의 "게임 파일 무결성 확인" 이 한다.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { ensureDir } from './paths.ts';
import { STAGING_DIR_NAME, createDirCache, resolveCaseInsensitive, safeRelPath } from './fsutil.ts';
import { sha256File } from './hash.ts';
import type { CheckItem, CheckResult, CommitResult, PatchRoot, PutFileResult, SessionInfo, SteamGame } from './types.ts';

export function rootBase(game: SteamGame, root: PatchRoot): string {
  if (root === 'prefix') {
    if (!game.prefixPath) throw new Error(`Proton prefix 가 없습니다: ${game.name}`);
    return game.prefixPath;
  }
  return game.gamePath;
}

// --- 경로 안전성 --------------------------------------------------------

/**
 * 존재하는 구간을 디스크의 실제 경로로 바꾼다.
 *
 * 심볼릭 링크, Windows 8.3 단축 이름(VERYLO~1.PAK), 대소문자가 한꺼번에 정규화된다.
 * 아직 없는 뒷부분은 이름 그대로 이어 붙인다.
 */
function canonicalize(p: string): string {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch { /* 아직 없는 경로 */ }
    const parent = path.dirname(cur);
    if (parent === cur) return p;
    tail.push(path.basename(cur));
    cur = parent;
  }
}

function isInside(realBase: string, target: string): boolean {
  const rel = path.relative(realBase, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface WriteTarget {
  /** 실제로 쓸 절대 경로 (심볼릭 링크와 8.3 이름을 모두 푼 값) */
  fullPath: string;
  /** 이미 파일이 있는지 */
  existsAsFile: boolean;
  /** 게임 폴더 기준 상대 경로 (디스크에 기록된 철자) */
  diskRel: string;
}

/**
 * 쓸 위치를 정하고, 위험하면 거부한다.
 *
 * 막는 것:
 * - 같은 이름의 폴더를 파일로 덮어쓰기 (그대로 두면 폴더 트리가 통째로 지워진다)
 * - 게임 폴더 밖으로 나가는 심볼릭 링크 (Proton prefix 의 Documents 등은 보통 사용자 홈으로 향한다)
 * - 끊어진 심볼릭 링크 (어디에 쓰일지 알 수 없다)
 */
export function resolveWriteTarget(base: string, rel: string): WriteTarget {
  const realBase = canonicalize(base);

  // 먼저 대소문자만 다른 기존 항목을 찾고, 그다음 실제 경로로 정규화한다.
  // 정규화는 경로 중간의 링크까지 풀어 주므로 마지막 조각만 검사할 때 남던 구멍이 사라진다.
  const fullPath = canonicalize(resolveCaseInsensitive(base, rel).fullPath);

  if (!isInside(realBase, fullPath)) {
    throw new Error(`게임 폴더 밖으로 나가는 경로라 거부했습니다: ${rel}`);
  }

  let link: fs.Stats | null = null;
  try { link = fs.lstatSync(fullPath); } catch { link = null; }

  // 정규화가 풀지 못한 링크는 대상이 없는 링크다. 어디에 쓰일지 알 수 없다.
  if (link?.isSymbolicLink()) {
    throw new Error(`끊어진 심볼릭 링크라 쓸 수 없습니다: ${rel}`);
  }
  if (link?.isDirectory()) {
    throw new Error(`같은 이름의 폴더가 있어 파일로 덮어쓸 수 없습니다: ${rel}`);
  }

  // 위에서 게임 폴더 안임을 확인했으므로 상대 경로에 .. 가 들어갈 수 없다.
  const diskRel = safeRelPath(path.relative(realBase, fullPath));

  return { fullPath, existsAsFile: link?.isFile() ?? false, diskRel };
}

// --- 비교 --------------------------------------------------------------

export async function checkFiles(base: string, files: CheckItem[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  // 읽기 전용 비교이므로 디렉터리 목록을 캐시해 같은 폴더를 반복해서 읽지 않는다
  const cache = createDirCache();
  for (const f of files) {
    const { fullPath, exists } = resolveCaseInsensitive(base, f.relPath, cache);
    let same = false;
    if (exists) {
      try {
        const st = fs.statSync(fullPath);
        if (st.isFile() && st.size === f.size) same = (await sha256File(fullPath)) === f.sha256;
      } catch { /* 읽기 실패 시 다른 파일로 취급 */ }
    }
    results.push({ relPath: f.relPath, exists, same, size: f.size });
  }
  return results;
}

// --- 검증하며 쓰기 --------------------------------------------------------

/**
 * 스트림을 임시 파일로 받으면서 해시를 계산하고, 일치할 때만 finalPath 로 이름을 바꾼다.
 * 실패하면 임시 파일을 지운다.
 */
async function writeVerified(stream: Readable, finalPath: string, sha256: string, size: number, label: string): Promise<void> {
  const destDir = path.dirname(finalPath);
  ensureDir(destDir);
  const tmp = path.join(destDir, `.sft-${randomBytes(6).toString('hex')}.tmp`);
  const hash = createHash('sha256');
  let received = 0;
  try {
    await pipeline(
      stream,
      async function* (src: AsyncIterable<Buffer>) {
        for await (const chunk of src) {
          hash.update(chunk);
          received += chunk.length;
          yield chunk;
        }
      },
      fs.createWriteStream(tmp),
    );
    const actual = hash.digest('hex');
    if (actual !== sha256 || received !== size) {
      throw new Error(`무결성 검사 실패: ${label} (기대 ${sha256.slice(0, 12)}/${size}B, 실제 ${actual.slice(0, 12)}/${received}B)`);
    }
    fs.renameSync(tmp, finalPath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

/** 이미 검증된 파일(fromPath)을 게임 폴더의 제자리에 놓는다. 같은 볼륨이라 rename 한 번이다. */
function installVerifiedFile(base: string, rel: string, fromPath: string): PutFileResult {
  const { fullPath, existsAsFile } = resolveWriteTarget(base, rel);
  try {
    ensureDir(path.dirname(fullPath));
    if (existsAsFile) fs.rmSync(fullPath, { force: true });
    fs.renameSync(fromPath, fullPath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const msg = e instanceof Error ? e.message : String(e);
    if (code === 'EEXIST' || code === 'ENOTDIR') {
      throw new Error(`경로 중간에 같은 이름의 파일이 있어 폴더를 만들 수 없습니다: ${rel}`);
    }
    throw new Error(`파일을 바꾸지 못했습니다 (게임이 실행 중이거나 파일이 잠겨 있을 수 있습니다): ${rel} — ${msg}`);
  }
  return { relPath: rel, written: true, replaced: existsAsFile, resolvedPath: fullPath };
}

// --- 단일 파일 직접 수신 (테스트와 소규모 용도) --------------------------

export interface ReceiveOptions {
  base: string;
  relPath: string;
  sha256: string;
  size: number;
  stream: Readable;
}

/** 파일 하나를 받아 곧바로 제자리에 놓는다. 검증 → 교체. */
export async function receiveFile(o: ReceiveOptions): Promise<PutFileResult> {
  const rel = safeRelPath(o.relPath);
  if (!rel) throw new Error('빈 경로');
  // 쓸 수 없는 위치면 받기 전에 거부한다
  const target = resolveWriteTarget(o.base, rel);
  const staged = path.join(path.dirname(target.fullPath), `.sft-${randomBytes(6).toString('hex')}.staged`);
  try {
    ensureDir(path.dirname(staged));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOTDIR') {
      throw new Error(`경로 중간에 같은 이름의 파일이 있어 폴더를 만들 수 없습니다: ${rel}`);
    }
    throw e;
  }
  await writeVerified(o.stream, staged, o.sha256, o.size, rel);
  try {
    return installVerifiedFile(o.base, rel, staged);
  } finally {
    try { fs.unlinkSync(staged); } catch { /* 이미 옮겨졌다 */ }
  }
}

// --- 세션 (임시 폴더에 받아 두었다가 한 번에 교체) ------------------------

/**
 * 임시 폴더 위치. 게임 폴더와 같은 볼륨이어야 rename 으로 원자적으로 옮길 수 있다.
 * steamapps 바로 아래에 두면 게임 폴더 안을 보는 도구들 눈에 띄지 않고, Steam 도 무시한다.
 */
export function stagingRoot(game: SteamGame, root: PatchRoot): string {
  const safeId = game.appId.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(game.libraryPath, 'steamapps', STAGING_DIR_NAME, `${safeId}-${root}`);
}

/**
 * 세션 ID 는 보낼 파일 목록의 내용으로 정한다.
 * 그래서 끊겼다가 같은 원본으로 다시 시도하면 같은 세션으로 이어받고,
 * 원본이 바뀌었으면 자연히 새 세션이 된다.
 */
export function sessionIdFor(files: CheckItem[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    h.update(`${f.relPath} ${f.sha256} ${f.size}\n`);
  }
  return h.digest('hex').slice(0, 16);
}

interface SessionFile { files: CheckItem[]; createdAt: string }

function sessionDir(game: SteamGame, root: PatchRoot, sessionId: string): string {
  if (!/^[0-9a-f]{16}$/.test(sessionId)) throw new Error(`잘못된 세션 ID: ${sessionId}`);
  return path.join(stagingRoot(game, root), sessionId);
}

function stagedPathFor(dir: string, rel: string): string {
  return path.join(dir, 'files', ...safeRelPath(rel).split('/'));
}

/** 오래 방치된 다른 세션의 임시 폴더를 정리한다 (7일) */
function pruneStaleSessions(game: SteamGame, root: PatchRoot, keep: string): void {
  const rootDir = stagingRoot(game, root);
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(rootDir, { withFileTypes: true }); } catch { return; }
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  for (const d of entries) {
    if (!d.isDirectory() || d.name === keep) continue;
    try {
      const st = fs.statSync(path.join(rootDir, d.name));
      if (st.mtimeMs < cutoff) fs.rmSync(path.join(rootDir, d.name), { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}

/**
 * 세션을 연다. 보낼 파일 전체 목록을 받아, 실제로 받아야 할 것만 추려 돌려준다.
 * 이미 같은 파일은 빼고, 임시 폴더에 이미 받아 둔 파일(끊긴 전송의 잔여)도 뺀다.
 */
export async function openSession(game: SteamGame, root: PatchRoot, files: CheckItem[], onlyExisting: boolean): Promise<SessionInfo> {
  const base = rootBase(game, root);
  const sessionId = sessionIdFor(files);
  const dir = sessionDir(game, root, sessionId);
  ensureDir(path.join(dir, 'files'));
  pruneStaleSessions(game, root, sessionId);

  const meta: SessionFile = { files, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(meta), 'utf8');

  const current = await checkFiles(base, files);
  const byPath = new Map(current.map((r) => [r.relPath, r]));

  const needed: string[] = [];
  let alreadySame = 0;
  let alreadyStaged = 0;
  let skippedMissing = 0;
  let newFiles = 0;

  for (const f of files) {
    const r = byPath.get(f.relPath);
    if (r?.same) { alreadySame++; continue; }
    if (!r?.exists) {
      if (onlyExisting) { skippedMissing++; continue; }
      newFiles++;
    }
    // 끊긴 전송에서 이미 받아 둔 파일인지. 받을 때 검증했지만 그 사이 손상됐을 수 있어 다시 해시한다.
    const staged = stagedPathFor(dir, f.relPath);
    try {
      const st = fs.statSync(staged);
      if (st.isFile() && st.size === f.size && (await sha256File(staged)) === f.sha256) { alreadyStaged++; continue; }
    } catch { /* 없다 */ }
    needed.push(f.relPath);
  }
  return { sessionId, needed, alreadySame, alreadyStaged, skippedMissing, newFiles };
}

/** 파일 하나를 임시 폴더에 받는다. 게임 폴더는 건드리지 않는다. */
export async function stageFile(game: SteamGame, root: PatchRoot, sessionId: string, relPath: string, sha256: string, size: number, stream: Readable): Promise<void> {
  const rel = safeRelPath(relPath);
  if (!rel) throw new Error('빈 경로');
  const dir = sessionDir(game, root, sessionId);
  if (!fs.existsSync(path.join(dir, 'session.json'))) throw new Error(`열려 있지 않은 세션입니다: ${sessionId}`);
  // 나중에 제자리로 옮길 때 거부될 경로면 받기 전에 알린다
  resolveWriteTarget(rootBase(game, root), rel);
  await writeVerified(stream, stagedPathFor(dir, rel), sha256, size, rel);
}

/**
 * 임시 폴더의 파일을 전부 제자리로 옮긴다. 파일마다 rename 한 번이다.
 * 실패한 파일은 임시 폴더에 남겨 다시 시도할 수 있게 하고, 전부 성공했을 때만 세션을 지운다.
 */
export async function commitSession(game: SteamGame, root: PatchRoot, sessionId: string): Promise<CommitResult> {
  const base = rootBase(game, root);
  const dir = sessionDir(game, root, sessionId);
  let meta: SessionFile;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')) as SessionFile;
  } catch {
    throw new Error(`세션 정보를 읽을 수 없습니다: ${sessionId}`);
  }

  let applied = 0;
  const failed: { relPath: string; reason: string }[] = [];
  for (const f of meta.files) {
    const staged = stagedPathFor(dir, f.relPath);
    if (!fs.existsSync(staged)) continue; // 이미 같아서 안 받았거나, 앞선 commit 에서 옮겨졌다
    try {
      installVerifiedFile(base, f.relPath, staged);
      applied++;
    } catch (e) {
      failed.push({ relPath: f.relPath, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  if (failed.length === 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    // 세션이 다 빠진 게임 폴더(<appId>-<root>)와 .sft-staging 자체도 비었으면 치운다. 비어 있지 않으면 그대로 둔다.
    for (const parent of [path.dirname(dir), path.dirname(path.dirname(dir))]) {
      try { fs.rmdirSync(parent); } catch { break; }
    }
  }
  return { applied, failed };
}

// 게임 단위 동기화: 어디서 읽어(Source) 어디에 쓸지(Target) 를 추상화해서
// "내 게임을 다른 기기로 보내기" 와 "상대 기기 게임을 내 쪽으로 받기" 를 같은 코드로 처리한다.
// 원본과 대상이 둘 다 원격이면 이 기기가 중계한다.
//
// 흐름: 원본 해시 → 대상에 세션 열기(필요한 파일만 추림) → 임시 폴더로 전송 → 한 번에 교체 → 전체 검증
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { PeerClient } from './client.ts';
import { hashTree } from './hash.ts';
import { checkFiles, commitSession, openSession, rootBase, stageFile } from './patch.ts';
import { findGame } from './steam.ts';
import type { CheckItem, CheckResult, CommitResult, PatchRoot, Peer, SessionInfo, SteamGame, TransferEvent, VerifySummary } from './types.ts';

// --- 읽는 쪽 -----------------------------------------------------------

export interface SourceAdapter {
  label: string;
  game(appId: string): Promise<SteamGame | undefined>;
  /** 게임 폴더 전체의 파일 목록과 해시 */
  list(appId: string, root: PatchRoot, onProgress?: (msg: string) => void): Promise<{ files: CheckItem[]; unreadable: { relPath: string; reason: string }[] }>;
  /** 파일 하나를 읽는 스트림 */
  open(appId: string, root: PatchRoot, relPath: string): Promise<Readable>;
}

export class LocalSource implements SourceAdapter {
  label = '이 기기';
  game(appId: string) { return findGame(appId); }
  async list(appId: string, root: PatchRoot, onProgress?: (msg: string) => void) {
    const g = await findGame(appId);
    if (!g) throw new Error(`설치되지 않은 게임: ${appId}`);
    return hashTree(rootBase(g, root), (done, total, rel) => onProgress?.(`해시 계산 ${done}/${total}: ${rel}`));
  }
  async open(appId: string, root: PatchRoot, relPath: string) {
    const g = await findGame(appId);
    if (!g) throw new Error(`설치되지 않은 게임: ${appId}`);
    return fs.createReadStream(path.join(rootBase(g, root), ...relPath.split('/')));
  }
}

export class RemoteSource implements SourceAdapter {
  readonly client: PeerClient;
  label: string;
  constructor(peer: Peer, password = '') {
    this.client = new PeerClient(peer.address, peer.port, password);
    this.label = peer.name || peer.address;
  }
  game(appId: string) { return notFoundAsUndefined(() => this.client.game(appId)); }
  async list(appId: string, root: PatchRoot, onProgress?: (msg: string) => void) {
    onProgress?.(`${this.label}: 파일 목록과 해시를 받는 중`);
    return this.client.tree(appId, root);
  }
  open(appId: string, root: PatchRoot, relPath: string) {
    return this.client.download(appId, root, relPath);
  }
}

// --- 쓰는 쪽 -----------------------------------------------------------

export interface TargetAdapter {
  label: string;
  game(appId: string): Promise<SteamGame | undefined>;
  openSession(appId: string, root: PatchRoot, files: CheckItem[], onlyExisting: boolean): Promise<SessionInfo>;
  stage(appId: string, root: PatchRoot, sessionId: string, relPath: string, size: number, sha256: string, stream: Readable, onProgress?: (b: number) => void): Promise<void>;
  commit(appId: string, root: PatchRoot, sessionId: string): Promise<CommitResult>;
  check(appId: string, root: PatchRoot, files: CheckItem[]): Promise<CheckResult[]>;
}

export class LocalTarget implements TargetAdapter {
  label = '이 기기';
  private async need(appId: string): Promise<SteamGame> {
    const g = await findGame(appId);
    if (!g) throw new Error(`설치되지 않은 게임: ${appId}`);
    return g;
  }
  game(appId: string) { return findGame(appId); }
  async openSession(appId: string, root: PatchRoot, files: CheckItem[], onlyExisting: boolean) {
    return openSession(await this.need(appId), root, files, onlyExisting);
  }
  async stage(appId: string, root: PatchRoot, sessionId: string, relPath: string, size: number, sha256: string, stream: Readable, onProgress?: (b: number) => void) {
    const g = await this.need(appId);
    let sent = 0;
    stream.on('data', (c: Buffer) => { sent += c.length; onProgress?.(sent); });
    await stageFile(g, root, sessionId, relPath, sha256, size, stream);
  }
  async commit(appId: string, root: PatchRoot, sessionId: string) {
    return commitSession(await this.need(appId), root, sessionId);
  }
  async check(appId: string, root: PatchRoot, files: CheckItem[]) {
    return checkFiles(rootBase(await this.need(appId), root), files);
  }
}

export class RemoteTarget implements TargetAdapter {
  readonly client: PeerClient;
  label: string;
  constructor(peer: Peer, password = '') {
    this.client = new PeerClient(peer.address, peer.port, password);
    this.label = peer.name || peer.address;
  }
  game(appId: string) { return notFoundAsUndefined(() => this.client.game(appId)); }
  openSession(appId: string, root: PatchRoot, files: CheckItem[], onlyExisting: boolean) {
    return this.client.openSession(appId, root, files, onlyExisting);
  }
  stage(appId: string, root: PatchRoot, sessionId: string, relPath: string, size: number, sha256: string, stream: Readable, onProgress?: (b: number) => void) {
    return this.client.stageFile(appId, root, sessionId, relPath, size, sha256, stream, onProgress);
  }
  commit(appId: string, root: PatchRoot, sessionId: string) { return this.client.commit(appId, root, sessionId); }
  check(appId: string, root: PatchRoot, files: CheckItem[]) { return this.client.check(appId, root, files); }
}

/**
 * 404 만 "설치 안 됨" 으로 보고, 나머지 오류(암호 필요, 연결 끊김)는 그대로 올린다.
 * 전부 삼키면 암호가 틀렸을 때도 "게임이 설치되어 있지 않습니다" 로 보여 원인을 찾을 수 없다.
 */
async function notFoundAsUndefined(fn: () => Promise<SteamGame>): Promise<SteamGame | undefined> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Error && /\(404\)/.test(e.message)) return undefined;
    throw e;
  }
}

// --- 계획 --------------------------------------------------------------

export interface PlanTarget {
  key: string;
  adapter: TargetAdapter;
  appId: string;
  root: PatchRoot;
}

export interface TargetPlan {
  key: string;
  label: string;
  appId: string;
  root: PatchRoot;
  gameName?: string;
  /** 게임이 없거나 접근 실패 등 */
  error?: string;
  sessionId?: string;
  toSend: CheckItem[];
  skippedSame: number;
  alreadyStaged: number;
  skippedMissing: number;
  newFiles: number;
  bytes: number;
}

export interface TransferPlan {
  source: SourceAdapter;
  sourceAppId: string;
  sourceRoot: PatchRoot;
  sourceLabel: string;
  sourceGameName: string;
  files: CheckItem[];
  targets: TargetPlan[];
  /** 읽지 못해 전송 목록에서 빠진 항목 */
  unreadable: { relPath: string; reason: string }[];
}

export interface PlanOptions {
  source: SourceAdapter;
  sourceAppId: string;
  sourceRoot: PatchRoot;
  targets: PlanTarget[];
  /** true 면 수신측에 이미 존재하는 파일만 보냄 (교집합) */
  onlyExisting: boolean;
  onProgress?: (msg: string) => void;
}

/** 원본 게임 폴더를 해시하고 각 대상에 세션을 열어 실제로 보낼 파일만 추린다 */
export async function planTransfer(o: PlanOptions): Promise<TransferPlan> {
  const sourceGame = await o.source.game(o.sourceAppId);
  if (!sourceGame) throw new Error(`${o.source.label}에 그 게임이 없습니다: ${o.sourceAppId}`);

  const { files, unreadable } = await o.source.list(o.sourceAppId, o.sourceRoot, o.onProgress);
  for (const u of unreadable) o.onProgress?.(`목록에서 제외: ${u.relPath} (${u.reason})`);
  const byPath = new Map(files.map((f) => [f.relPath, f]));

  const targets: TargetPlan[] = [];
  for (const t of o.targets) {
    const plan: TargetPlan = {
      key: t.key, label: t.adapter.label, appId: t.appId, root: t.root,
      toSend: [], skippedSame: 0, alreadyStaged: 0, skippedMissing: 0, newFiles: 0, bytes: 0,
    };
    try {
      const game = await t.adapter.game(t.appId);
      if (!game) throw new Error('대상 기기에 해당 게임이 설치되어 있지 않습니다');
      plan.gameName = game.name;
      o.onProgress?.(`${plan.label}: 파일 비교 중 (${files.length}개)`);
      const session = await t.adapter.openSession(t.appId, t.root, files, o.onlyExisting);
      plan.sessionId = session.sessionId;
      plan.skippedSame = session.alreadySame;
      plan.alreadyStaged = session.alreadyStaged;
      plan.skippedMissing = session.skippedMissing;
      plan.newFiles = session.newFiles;
      for (const rel of session.needed) {
        const f = byPath.get(rel);
        if (!f) continue;
        plan.toSend.push(f);
        plan.bytes += f.size;
      }
    } catch (e) {
      plan.error = e instanceof Error ? e.message : String(e);
    }
    targets.push(plan);
  }
  return {
    source: o.source,
    sourceAppId: o.sourceAppId,
    sourceRoot: o.sourceRoot,
    sourceLabel: o.source.label,
    sourceGameName: sourceGame.name,
    files,
    targets,
    unreadable,
  };
}

// --- 실행 --------------------------------------------------------------

export interface ExecuteOptions {
  plan: TransferPlan;
  adapters: Map<string, PlanTarget>;
  onEvent: (e: TransferEvent) => void;
  signal?: AbortSignal;
}

export interface ExecuteResult {
  files: number;
  failed: number;
  committed: number;
  commitFailed: number;
  verify: VerifySummary | null;
}

/**
 * 계획대로 전송한다. 대상별로 순차 진행.
 * 파일은 임시 폴더로 가고, 그 대상의 파일이 전부 도착했을 때만 교체(commit)한다.
 * 마지막에 전체 파일이 같은지 검사하지만, 그 결과로 성공/실패를 가르지는 않는다.
 */
export async function executeTransfer(o: ExecuteOptions): Promise<ExecuteResult> {
  const started = Date.now();
  const totalFiles = o.plan.targets.reduce((n, t) => n + (t.error ? 0 : t.toSend.length), 0);
  const totalBytes = o.plan.targets.reduce((n, t) => n + (t.error ? 0 : t.bytes), 0);
  o.onEvent({ kind: 'start', totalFiles, totalBytes });
  let done = 0;
  let failed = 0;
  let committed = 0;
  let commitFailed = 0;
  let doneBytes = 0;
  let index = 0;
  let aborted = false;
  const verify: VerifySummary = { same: 0, differ: 0, missing: 0 };
  let verified = false;

  for (const tp of o.plan.targets) {
    if (aborted) break;
    if (tp.error || !tp.sessionId) { o.onEvent({ kind: 'skip', relPath: '', reason: tp.error ?? '세션 없음', target: tp.label }); continue; }
    const pt = o.adapters.get(tp.key);
    if (!pt) continue;

    let targetFailed = 0;
    for (const f of tp.toSend) {
      // 중단하면 남은 기기까지 전부 멈춘다. 임시 폴더에 받아 둔 것은 남아 다음에 이어받는다.
      if (o.signal?.aborted) {
        aborted = true;
        o.onEvent({ kind: 'error', message: '사용자가 중단했습니다. 받아 둔 파일은 남겨 두었으니 다시 시도하면 이어받습니다.', target: tp.label });
        break;
      }
      index++;
      const base = doneBytes;

      let stream: Readable;
      try {
        stream = await o.plan.source.open(o.plan.sourceAppId, o.plan.sourceRoot, f.relPath);
      } catch (e) {
        failed++; targetFailed++;
        o.onEvent({ kind: 'error', relPath: f.relPath, message: e instanceof Error ? e.message : String(e), target: tp.label });
        if (o.signal?.aborted) aborted = true;
        continue;
      }

      // 어댑터가 리스너를 붙이기 전에 스트림이 실패할 수 있다.
      // 그때 'error' 리스너가 하나도 없으면 프로세스 전체가 죽는다.
      let streamError: Error | null = null;
      stream.on('error', (e: Error) => { streamError = e; });

      // 취소를 스트림에 연결한다. 이게 없으면 큰 파일 하나가 끝날 때까지 중단이 먹지 않는다.
      const onAbort = (): void => { stream.destroy(new Error('사용자가 중단했습니다')); };
      o.signal?.addEventListener('abort', onAbort, { once: true });

      try {
        await pt.adapter.stage(tp.appId, tp.root, tp.sessionId, f.relPath, f.size, f.sha256, stream, (b) => {
          o.onEvent({ kind: 'file', relPath: f.relPath, index, totalFiles, bytes: f.size, doneBytes: base + b, totalBytes, target: tp.label });
        });
        done++;
        doneBytes = base + f.size;
        o.onEvent({ kind: 'file', relPath: f.relPath, index, totalFiles, bytes: f.size, doneBytes, totalBytes, target: tp.label });
      } catch (e) {
        failed++; targetFailed++;
        // 실패한 파일의 바이트는 더하지 않는다. "성공 0개, 3.2GB" 같은 표시를 막는다.
        const err = streamError ?? e;
        o.onEvent({ kind: 'error', relPath: f.relPath, message: err instanceof Error ? err.message : String(err), target: tp.label });
        if (o.signal?.aborted) aborted = true;
      } finally {
        o.signal?.removeEventListener('abort', onAbort);
        stream.destroy();
      }
    }

    // 전부 도착했을 때만 교체한다. 하나라도 못 받았으면 게임 폴더를 건드리지 않고 다음 시도로 넘긴다.
    if (aborted || targetFailed > 0) {
      o.onEvent({ kind: 'skip', relPath: '', reason: `${targetFailed}개 파일을 받지 못해 교체하지 않았습니다. 다시 시도하면 이어받습니다.`, target: tp.label });
      continue;
    }
    try {
      o.onEvent({ kind: 'committing', target: tp.label });
      const r = await pt.adapter.commit(tp.appId, tp.root, tp.sessionId);
      committed += r.applied;
      commitFailed += r.failed.length;
      for (const f of r.failed) o.onEvent({ kind: 'error', relPath: f.relPath, message: f.reason, target: tp.label });
    } catch (e) {
      commitFailed++;
      o.onEvent({ kind: 'error', message: `교체 실패: ${e instanceof Error ? e.message : String(e)}`, target: tp.label });
      continue;
    }

    // 최종 검증: 전체 파일이 같은지. 참고 정보이지 성공/실패의 기준은 아니다.
    try {
      o.onEvent({ kind: 'verifying', target: tp.label });
      const results = await pt.adapter.check(tp.appId, tp.root, o.plan.files);
      for (const r of results) {
        if (r.same) verify.same++;
        else if (r.exists) verify.differ++;
        else verify.missing++;
      }
      verified = true;
    } catch (e) {
      o.onEvent({ kind: 'error', message: `검증 실패: ${e instanceof Error ? e.message : String(e)}`, target: tp.label });
    }
  }

  const result: ExecuteResult = { files: done, failed, committed, commitFailed, verify: verified ? verify : null };
  o.onEvent({ kind: 'done', files: done, failed, bytes: doneBytes, elapsedMs: Date.now() - started, verify: result.verify, committed, commitFailed });
  return result;
}

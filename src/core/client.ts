// 다른 기기의 HTTP API 를 호출하는 클라이언트
import http from 'node:http';
import type { Readable } from 'node:stream';
import type { HashedTree } from './hash.ts';
import type { InboundSession } from './inbound.ts';
import type { CheckItem, CheckResult, CommitResult, DeviceInfo, DirEntry, PatchRoot, SessionInfo, SteamGame } from './types.ts';

export class PasswordRequiredError extends Error {
  constructor(sentPassword: boolean) {
    // 암호를 보냈는데도 401 이면 틀린 것이다. 같은 문구를 쓰면 사용자는 원인을 알 수 없다.
    super(sentPassword ? '암호가 맞지 않습니다' : '암호가 필요합니다');
    this.name = 'PasswordRequiredError';
  }
}

/** 서버가 돌려준 JSON 오류 본문에서 사람이 읽을 메시지만 꺼낸다 */
function errorText(status: number, body: string): string {
  try {
    const j = JSON.parse(body) as { error?: string };
    if (typeof j.error === 'string' && j.error) return j.error;
  } catch { /* JSON 이 아니면 원문을 쓴다 */ }
  return body.trim() ? `${body.slice(0, 200)} (HTTP ${status})` : `HTTP ${status}`;
}

export class PeerClient {
  constructor(
    readonly address: string,
    readonly port: number,
    public password = '',
  ) {}

  get baseUrl(): string { return `http://${this.address}:${this.port}`; }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.password) h['x-sft-password'] = this.password;
    return h;
  }

  private async json<T>(method: string, pathname: string, body?: unknown, timeoutMs = 15000): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(this.baseUrl + pathname, {
        method,
        headers: this.headers(body === undefined ? {} : { 'content-type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.status === 401) throw new PasswordRequiredError(this.password.length > 0);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // 404 는 호출자가 "설치 안 됨" 으로 구분하므로 상태 코드를 남긴다
        throw new Error(`${errorText(res.status, text)} (${res.status})`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  info(): Promise<DeviceInfo> { return this.json('GET', '/api/info'); }
  status(): Promise<{ self: DeviceInfo; inbound: InboundSession[] }> { return this.json('GET', '/api/status', undefined, 5000); }
  games(): Promise<SteamGame[]> { return this.json('GET', '/api/games', undefined, 30000); }
  game(appId: string): Promise<SteamGame> { return this.json('GET', `/api/games/${encodeURIComponent(appId)}`); }
  dir(appId: string, root: PatchRoot, rel: string): Promise<DirEntry[]> {
    return this.json('GET', `/api/games/${encodeURIComponent(appId)}/dir?root=${root}&path=${encodeURIComponent(rel)}`);
  }
  check(appId: string, root: PatchRoot, files: CheckItem[]): Promise<CheckResult[]> {
    return this.json('POST', `/api/games/${encodeURIComponent(appId)}/check?root=${root}`, { files }, 30 * 60 * 1000);
  }
  /** 상대 기기 게임 폴더의 파일 목록과 해시. "받기" 의 첫 단계다. 큰 게임은 오래 걸린다. */
  tree(appId: string, root: PatchRoot): Promise<HashedTree> {
    return this.json('GET', `/api/games/${encodeURIComponent(appId)}/tree?root=${root}`, undefined, 30 * 60 * 1000);
  }

  /** 세션을 열어 실제로 보낼 파일만 추린다. 상대는 파일 목록 전체를 해시 비교하므로 오래 걸릴 수 있다. */
  openSession(appId: string, root: PatchRoot, files: CheckItem[], onlyExisting: boolean): Promise<SessionInfo> {
    return this.json('POST', `/api/games/${encodeURIComponent(appId)}/session?root=${root}`, { files, onlyExisting }, 30 * 60 * 1000);
  }

  /** 임시 폴더에 받아 둔 파일을 제자리로 교체한다 */
  commit(appId: string, root: PatchRoot, sessionId: string): Promise<CommitResult> {
    return this.json('POST', `/api/games/${encodeURIComponent(appId)}/commit?root=${root}&session=${sessionId}`, {}, 30 * 60 * 1000);
  }

  /** 게임 아이콘. 없으면 null */
  async icon(appId: string): Promise<{ mime: string; data: Buffer } | null> {
    const res = await fetch(`${this.baseUrl}/api/games/${encodeURIComponent(appId)}/icon`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 404) return null;
    if (res.status === 401) throw new PasswordRequiredError(this.password.length > 0);
    if (!res.ok) return null;
    return { mime: res.headers.get('content-type') ?? 'image/jpeg', data: Buffer.from(await res.arrayBuffer()) };
  }

  /** 파일 하나를 스트림으로 내려받는다. 응답 헤더가 오면 스트림을 돌려주고, 오류 상태면 거부한다. */
  download(appId: string, root: PatchRoot, relPath: string): Promise<Readable> {
    return new Promise((resolve, reject) => {
      const req = http.get({
        host: this.address,
        port: this.port,
        path: `/api/games/${encodeURIComponent(appId)}/file?root=${root}&path=${encodeURIComponent(relPath)}`,
        headers: this.headers(),
        timeout: 10 * 60 * 1000,
      });
      req.on('timeout', () => req.destroy(new Error('전송 시간 초과')));
      req.on('error', reject);
      req.on('response', (res) => {
        if (res.statusCode === 200) return resolve(res);
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode === 401) return reject(new PasswordRequiredError(this.password.length > 0));
          reject(new Error(`${relPath}: ${errorText(res.statusCode ?? 0, data)}`));
        });
      });
    });
  }

  /** 파일 하나를 상대의 임시 폴더로 스트리밍 업로드. 수신측이 해시를 검증한다. */
  stageFile(appId: string, root: PatchRoot, sessionId: string, relPath: string, size: number, sha256: string, stream: Readable, onProgress?: (bytes: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      // 실패해도 소스 스트림을 반드시 닫는다. 안 그러면 파일 하나 실패할 때마다
      // 열린 파일 디스크립터가 쌓여 결국 EMFILE 로 앱이 멈춘다.
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        stream.destroy();
        fn();
      };
      const req = http.request({
        host: this.address,
        port: this.port,
        method: 'PUT',
        path: `/api/games/${encodeURIComponent(appId)}/stage?root=${root}&session=${sessionId}&path=${encodeURIComponent(relPath)}&sha256=${sha256}`,
        headers: this.headers({ 'content-type': 'application/octet-stream', 'content-length': String(size) }),
        timeout: 10 * 60 * 1000,
      });
      req.on('timeout', () => req.destroy(new Error('전송 시간 초과')));
      req.on('error', (e) => finish(() => reject(e)));
      req.on('response', (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode === 401) return finish(() => reject(new PasswordRequiredError(this.password.length > 0)));
          if (res.statusCode !== 200) return finish(() => reject(new Error(`${relPath}: ${errorText(res.statusCode ?? 0, data)}`)));
          finish(resolve);
        });
      });
      let sent = 0;
      stream.on('data', (c: Buffer) => { sent += c.length; onProgress?.(sent); });
      stream.on('error', (e) => req.destroy(e));
      stream.pipe(req);
    });
  }
}

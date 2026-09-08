// 이 기기를 다른 기기에 노출하는 HTTP API 서버 (의존성 없이 node:http 사용)
//
// 받는 쪽 역할(session/stage/commit)과 보내는 쪽 역할(tree, file 내려받기)을 둘 다 제공한다.
// 그래서 어느 기기에서든 "보내기" 와 "받기" 가 가능하다.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Transform } from 'node:stream';
import { URL } from 'node:url';
import { listDir, safeRelPath } from './fsutil.ts';
import { hashTree } from './hash.ts';
import { findGame, listInstalledGames, readGameIcon } from './steam.ts';
import { checkFiles, commitSession, openSession, resolveWriteTarget, rootBase, stageFile } from './patch.ts';
import type { InboundTracker } from './inbound.ts';
import type { AppConfig, CheckItem, DeviceInfo, PatchRoot, SessionRequest } from './types.ts';

export interface ServerDeps {
  config: () => AppConfig;
  self: () => DeviceInfo;
  log: (msg: string) => void;
  inbound: InboundTracker;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

async function readJson<T>(req: http.IncomingMessage, limit = 64 * 1024 * 1024): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('요청 본문이 너무 큽니다');
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as T;
}

function parseRoot(v: string | null): PatchRoot {
  return v === 'prefix' ? 'prefix' : 'game';
}

export function createServer(deps: ServerDeps): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cfg = deps.config();
    const from = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '?';
    try {
      // 암호가 설정된 경우 헤더 검사 (info 와 status 는 예외)
      const open = url.pathname === '/api/info' || url.pathname === '/api/status';
      if (cfg.password && !open && req.headers['x-sft-password'] !== cfg.password) {
        return sendJson(res, 401, { error: 'password' });
      }

      if (req.method === 'GET' && url.pathname === '/api/info') return sendJson(res, 200, deps.self());
      // 화면이 백그라운드 서비스의 수신 현황을 볼 때 쓴다. 같은 기기의 화면만 부르지만 내용에 비밀은 없다.
      if (req.method === 'GET' && url.pathname === '/api/status') {
        return sendJson(res, 200, { self: deps.self(), inbound: deps.inbound.list() });
      }
      if (req.method === 'GET' && url.pathname === '/api/games') return sendJson(res, 200, await listInstalledGames());

      const m = /^\/api\/games\/([^/]+)(?:\/(\w+))?$/.exec(url.pathname);
      if (!m) return sendJson(res, 404, { error: 'not found' });
      const appId = decodeURIComponent(m[1]);
      const action = m[2] ?? '';
      const root = parseRoot(url.searchParams.get('root'));

      // 아이콘은 게임 폴더가 없어도 캐시에 있을 수 있으니 게임 조회 전에 처리한다
      if (req.method === 'GET' && action === 'icon') {
        const icon = await readGameIcon(appId);
        if (!icon) return sendJson(res, 404, { error: 'no icon' });
        res.writeHead(200, { 'content-type': icon.mime, 'content-length': icon.data.length, 'cache-control': 'max-age=3600' });
        return res.end(icon.data);
      }

      const game = await findGame(appId);
      if (!game) return sendJson(res, 404, { error: `설치되지 않은 게임: ${appId}` });

      if (req.method === 'GET' && action === '') return sendJson(res, 200, game);

      if (req.method === 'GET' && action === 'dir') {
        const base = rootBase(game, root);
        const rel = safeRelPath(url.searchParams.get('path') ?? '');
        return sendJson(res, 200, listDir(rel ? path.join(base, rel) : base));
      }

      // --- 보내는 쪽이 이 기기에서 "받기" 할 때 -------------------------
      if (req.method === 'GET' && action === 'tree') {
        return sendJson(res, 200, await hashTree(rootBase(game, root)));
      }
      if (req.method === 'GET' && action === 'file') {
        const rel = url.searchParams.get('path') ?? '';
        if (!rel) return sendJson(res, 400, { error: 'path 필요' });
        // 읽기라도 게임 폴더 밖으로 나가는 링크는 따라가지 않는다
        const target = resolveWriteTarget(rootBase(game, root), rel);
        if (!target.existsAsFile) return sendJson(res, 404, { error: `파일이 없습니다: ${rel}` });
        const st = fs.statSync(target.fullPath);
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': st.size });
        const stream = fs.createReadStream(target.fullPath);
        stream.on('error', (e) => { deps.log(`파일 전송 오류 ${rel}: ${e.message}`); res.destroy(e); });
        return stream.pipe(res);
      }

      // --- 이 기기가 받는 쪽일 때 -----------------------------------------
      if (req.method === 'POST' && action === 'check') {
        const body = await readJson<{ files: CheckItem[] }>(req);
        return sendJson(res, 200, await checkFiles(rootBase(game, root), body.files ?? []));
      }

      if (req.method === 'POST' && action === 'session') {
        const body = await readJson<SessionRequest>(req);
        const info = await openSession(game, root, body.files ?? [], Boolean(body.onlyExisting));
        deps.inbound.open(info.sessionId, appId, game.name, from, info.needed.length);
        deps.log(`세션 열림: ${game.name} ← ${from} (받을 파일 ${info.needed.length}개, 이미 같음 ${info.alreadySame}개, 이어받기 ${info.alreadyStaged}개)`);
        return sendJson(res, 200, info);
      }

      if (req.method === 'PUT' && action === 'stage') {
        const rel = url.searchParams.get('path') ?? '';
        const sha = url.searchParams.get('sha256') ?? '';
        const sessionId = url.searchParams.get('session') ?? '';
        const size = Number(req.headers['content-length'] ?? -1);
        if (!rel || !sessionId || !/^[0-9a-f]{64}$/.test(sha) || size < 0) {
          return sendJson(res, 400, { error: 'session/path/sha256/content-length 필요' });
        }
        // 수신 현황에 바이트 진행을 알린다. pipe 라 배압도 유지된다.
        const counter = new Transform({
          transform(chunk: Buffer, _enc, cb) { deps.inbound.bytes(sessionId, chunk.length); cb(null, chunk); },
        });
        req.on('error', (e) => counter.destroy(e));
        req.pipe(counter);
        await stageFile(game, root, sessionId, rel, sha, size, counter);
        deps.inbound.fileDone(sessionId);
        return sendJson(res, 200, { relPath: rel, staged: true });
      }

      if (req.method === 'POST' && action === 'commit') {
        const sessionId = url.searchParams.get('session') ?? '';
        if (!sessionId) return sendJson(res, 400, { error: 'session 필요' });
        deps.inbound.committing(sessionId);
        try {
          const r = await commitSession(game, root, sessionId);
          const msg = `교체 ${r.applied}개${r.failed.length ? `, 실패 ${r.failed.length}개` : ''}`;
          if (r.failed.length > 0) deps.inbound.failed(sessionId, msg);
          else deps.inbound.done(sessionId, msg);
          deps.log(`교체 완료: ${game.name} ← ${from} (${msg})`);
          return sendJson(res, 200, r);
        } catch (e) {
          deps.inbound.failed(sessionId, e instanceof Error ? e.message : String(e));
          throw e;
        }
      }


      return sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.log(`요청 오류 ${req.method} ${url.pathname}: ${msg}`);
      if (!res.headersSent) sendJson(res, 500, { error: msg });
      else res.end();
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60000;
  server.keepAliveTimeout = 30000;
  return server;
}

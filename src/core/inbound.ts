// 이 기기로 들어오는 수신 현황.
// 백그라운드 서비스가 받는 중이어도 화면을 열면 무엇이 어디서 얼마나 들어오는지 보여야 한다.
import { EventEmitter } from 'node:events';

export type InboundState = 'receiving' | 'committing' | 'done' | 'failed';

export interface InboundSession {
  sessionId: string;
  appId: string;
  gameName: string;
  /** 보내는 기기 주소 */
  from: string;
  state: InboundState;
  /** 이번 세션에서 받아야 할 파일 수 */
  needed: number;
  received: number;
  bytes: number;
  startedAt: number;
  updatedAt: number;
  message?: string;
}

const KEEP_FINISHED_MS = 10 * 60 * 1000;

export class InboundTracker extends EventEmitter {
  private readonly sessions = new Map<string, InboundSession>();

  open(sessionId: string, appId: string, gameName: string, from: string, needed: number): void {
    const now = Date.now();
    const prev = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      sessionId, appId, gameName, from, needed,
      state: 'receiving',
      // 이어받기면 이전에 받은 양은 그대로 둔다
      received: prev?.state === 'receiving' ? prev.received : 0,
      bytes: prev?.state === 'receiving' ? prev.bytes : 0,
      startedAt: prev?.state === 'receiving' ? prev.startedAt : now,
      updatedAt: now,
    });
    this.emit('change');
  }

  bytes(sessionId: string, delta: number): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.bytes += delta;
    s.updatedAt = Date.now();
    this.emit('progress');
  }

  fileDone(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.received++;
    s.updatedAt = Date.now();
    this.emit('change');
  }

  committing(sessionId: string): void {
    this.set(sessionId, 'committing');
  }

  done(sessionId: string, message?: string): void {
    this.set(sessionId, 'done', message);
  }

  failed(sessionId: string, message: string): void {
    this.set(sessionId, 'failed', message);
  }

  private set(sessionId: string, state: InboundState, message?: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.state = state;
    s.message = message;
    s.updatedAt = Date.now();
    this.emit('change');
  }

  /** 최근 것부터. 끝난 지 오래된 것은 지운다 */
  list(): InboundSession[] {
    const now = Date.now();
    for (const [k, s] of this.sessions) {
      if ((s.state === 'done' || s.state === 'failed') && now - s.updatedAt > KEEP_FINISHED_MS) this.sessions.delete(k);
    }
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

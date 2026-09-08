// 한 기기에서 동작하는 노드: 설정 + 탐색 + 수신 서버. GUI 와 데몬이 공유한다.
import os from 'node:os';
import type http from 'node:http';
import { EventEmitter } from 'node:events';
import { detectOs, loadConfig, saveConfig } from './config.ts';
import { invalidateGameCache } from './steam.ts';
import { InboundTracker } from './inbound.ts';
import { Discovery } from './discovery.ts';
import { createServer } from './server.ts';
import type { AppConfig, DeviceInfo, Peer } from './types.ts';

export type NodeMode = 'serving' | 'daemon-running' | 'client-only';

export interface NodeStatus {
  mode: NodeMode;
  addresses: string[];
  port: number;
  message: string;
}

export const APP_VERSION = '0.1.1';

export function localAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
  }
  return out;
}

export class TransferNode extends EventEmitter {
  config: AppConfig;
  readonly discovery: Discovery;
  /** 이 기기로 들어오는 수신 현황 */
  readonly inbound = new InboundTracker();
  private server?: http.Server;
  private status: NodeStatus;

  constructor() {
    super();
    this.config = loadConfig();
    this.discovery = new Discovery(this.config.discoveryPort, () => this.selfInfo());
    this.discovery.on('change', () => this.emit('peers', this.peers()));
    this.discovery.on('log', (m: string) => this.log(m));
    this.status = { mode: 'client-only', addresses: localAddresses(), port: this.config.port, message: '' };
  }

  log(msg: string): void {
    this.emit('log', `[${new Date().toLocaleTimeString()}] ${msg}`);
  }

  selfInfo(): DeviceInfo {
    return {
      id: this.config.deviceId,
      name: this.config.deviceName,
      os: detectOs(),
      hostname: os.hostname(),
      version: APP_VERSION,
      port: this.config.port,
      requiresPassword: this.config.password.length > 0,
    };
  }

  selfPeer(): Peer {
    return { ...this.selfInfo(), address: localAddresses()[0] ?? '127.0.0.1', lastSeen: Date.now(), self: true };
  }

  peers(): Peer[] {
    return this.discovery.list();
  }

  getStatus(): NodeStatus {
    return { ...this.status, addresses: localAddresses() };
  }

  updateConfig(patch: Partial<AppConfig>): AppConfig {
    const steamRootChanged = patch.steamRoot !== undefined && patch.steamRoot !== this.config.steamRoot;
    this.config = { ...this.config, ...patch };
    saveConfig(this.config);
    if (steamRootChanged) invalidateGameCache();
    this.emit('config', this.config);
    return this.config;
  }

  /** 서버를 띄운다. 포트가 이미 사용 중이고 그것이 우리 데몬이면 client-only 로 동작 */
  async start(): Promise<NodeStatus> {
    const port = this.config.port;
    const server = createServer({
      config: () => this.config,
      self: () => this.selfInfo(),
      log: (m) => this.log(m),
      inbound: this.inbound,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onListenError = (e: Error): void => reject(e);
        server.once('error', onListenError);
        server.listen(port, '0.0.0.0', () => {
          server.off('error', onListenError);
          // listen 이후에도 error 리스너가 있어야 한다. 없으면 나중에 나는 오류로 프로세스가 죽는다.
          server.on('error', (e: Error) => this.log(`수신 서버 오류: ${e.message}`));
          resolve();
        });
      });
      this.server = server;
      this.status = { mode: 'serving', addresses: localAddresses(), port, message: `수신 대기 중 (포트 ${port})` };
      await this.discovery.start().catch((e: Error) => this.log(`탐색 시작 실패: ${e.message}`));
    } catch (e) {
      // 열지 못한 서버는 닫아 둔다
      try { server.close(); } catch { /* ignore */ }
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE') {
        const ours = await this.probeLocalDaemon(port);
        if (ours) {
          this.status = { mode: 'daemon-running', addresses: localAddresses(), port, message: `백그라운드 서비스가 이미 수신 중 (포트 ${port})` };
          // 데몬이 광고 중이므로 자신은 탐색 수신만 필요. 포트 공유(reuseAddr) 로 같이 듣는다.
          await this.discovery.start().catch((err: Error) => this.log(`탐색 시작 실패: ${err.message}`));
        } else {
          this.status = { mode: 'client-only', addresses: localAddresses(), port, message: `포트 ${port} 가 다른 프로그램에 사용 중입니다. 보내기만 가능합니다.` };
          await this.discovery.start().catch((err: Error) => this.log(`탐색 시작 실패: ${err.message}`));
        }
      } else {
        this.status = { mode: 'client-only', addresses: localAddresses(), port, message: `서버 시작 실패: ${(e as Error).message}` };
      }
    }
    this.log(this.status.message);
    return this.status;
  }

  /**
   * 그 포트를 쥔 것이 우리 데몬인지 확인한다.
   *
   * 로컬 루프백 호출이지만 게임이 돌고 있는 덱처럼 부하가 큰 기기에서는 몇 초씩 걸린다.
   * 성급하게 포기하면 데몬이 멀쩡히 도는데도 "다른 프로그램이 점유" 로 잘못 알린다.
   */
  private async probeLocalDaemon(port: number): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return false;
        const info = (await res.json()) as DeviceInfo;
        return info.id === this.config.deviceId;
      } catch (e) {
        // 연결이 거부되면 우리 데몬이 아니다. 시간 초과일 때만 다시 시도한다.
        const name = e instanceof Error ? e.name : '';
        if (name !== 'TimeoutError' && name !== 'AbortError') return false;
      }
    }
    return false;
  }

  async stop(): Promise<void> {
    this.discovery.stop();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = undefined;
    }
  }
}

// UDP 멀티캐스트/브로드캐스트 기반 기기 자동 탐색 (설정 없이 같은 내부망에서 서로 발견)
import dgram from 'node:dgram';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { MULTICAST_GROUP, PROTOCOL_MAGIC, type DeviceInfo, type Peer } from './types.ts';

interface AnnouncePacket extends DeviceInfo { t: string; q?: 0 | 1 }

const ANNOUNCE_INTERVAL_MS = 3000;
const EXPIRE_MS = 10000;

function ipv4Interfaces(): { address: string; netmask: string }[] {
  const out: { address: string; netmask: string }[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      out.push({ address: ni.address, netmask: ni.netmask });
    }
  }
  return out;
}

function broadcastAddress(address: string, netmask: string): string {
  const a = address.split('.').map(Number);
  const m = netmask.split('.').map(Number);
  return a.map((x, i) => (x | (~m[i] & 255)) & 255).join('.');
}

export class Discovery extends EventEmitter {
  private socket?: dgram.Socket;
  private timer?: NodeJS.Timeout;
  private readonly peers = new Map<string, Peer>();
  private joined = new Set<string>();

  constructor(
    private readonly port: number,
    private readonly self: () => DeviceInfo,
  ) {
    super();
  }

  list(): Peer[] {
    const now = Date.now();
    for (const [id, p] of this.peers) if (now - p.lastSeen > EXPIRE_MS) { this.peers.delete(id); this.emit('change'); }
    return [...this.peers.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async start(): Promise<void> {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = sock;
    sock.on('error', (e) => this.emit('log', `탐색 소켓 오류: ${e.message}`));
    sock.on('message', (msg, rinfo) => this.onMessage(msg, rinfo.address));
    await new Promise<void>((resolve, reject) => {
      sock.once('error', reject);
      sock.bind(this.port, () => { sock.off('error', reject); resolve(); });
    });
    try { sock.setBroadcast(true); } catch { /* ignore */ }
    try { sock.setMulticastTTL(4); } catch { /* ignore */ }
    this.joinGroups();
    this.timer = setInterval(() => { this.joinGroups(); this.announce(); this.list(); }, ANNOUNCE_INTERVAL_MS);
    this.announce(1); // 시작 직후 질의: 기존 기기들이 즉시 응답
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.socket?.close();
    this.socket = undefined;
    this.peers.clear();
    // 새 소켓은 멀티캐스트 그룹에 다시 가입해야 한다. 안 비우면 재시작 시 가입을 건너뛴다.
    this.joined.clear();
  }

  /** 인터페이스가 늘어나면(무선 연결 등) 새로 가입 */
  private joinGroups(): void {
    if (!this.socket) return;
    for (const ni of ipv4Interfaces()) {
      if (this.joined.has(ni.address)) continue;
      try {
        this.socket.addMembership(MULTICAST_GROUP, ni.address);
        this.joined.add(ni.address);
      } catch { /* 일부 인터페이스는 멀티캐스트 불가 */ }
    }
    if (this.joined.size === 0) {
      try { this.socket.addMembership(MULTICAST_GROUP); this.joined.add('*'); } catch { /* ignore */ }
    }
  }

  announce(q: 0 | 1 = 0, to?: string): void {
    if (!this.socket) return;
    const pkt: AnnouncePacket = { t: PROTOCOL_MAGIC, q, ...this.self() };
    const buf = Buffer.from(JSON.stringify(pkt));
    if (to) { this.socket.send(buf, this.port, to); return; }
    const targets = new Set<string>(['255.255.255.255']);
    for (const ni of ipv4Interfaces()) {
      targets.add(broadcastAddress(ni.address, ni.netmask));
      try {
        this.socket.setMulticastInterface(ni.address);
        this.socket.send(buf, this.port, MULTICAST_GROUP);
      } catch { /* ignore */ }
    }
    for (const t of targets) {
      try { this.socket.send(buf, this.port, t); } catch { /* ignore */ }
    }
  }

  private onMessage(msg: Buffer, address: string): void {
    let pkt: AnnouncePacket;
    try { pkt = JSON.parse(msg.toString('utf8')) as AnnouncePacket; } catch { return; }
    if (pkt.t !== PROTOCOL_MAGIC || typeof pkt.id !== 'string') return;
    const me = this.self();
    if (pkt.id === me.id) return;
    const existing = this.peers.get(pkt.id);
    const peer: Peer = {
      id: pkt.id,
      name: String(pkt.name ?? ''),
      os: pkt.os ?? 'unknown',
      hostname: String(pkt.hostname ?? ''),
      version: String(pkt.version ?? ''),
      port: Number(pkt.port) || 0,
      requiresPassword: Boolean(pkt.requiresPassword),
      address,
      lastSeen: Date.now(),
      self: false,
    };
    this.peers.set(pkt.id, peer);
    if (!existing || existing.address !== address || existing.name !== peer.name || existing.requiresPassword !== peer.requiresPassword) {
      this.emit('change');
    }
    if (pkt.q === 1) this.announce(0, address); // 질의에는 유니캐스트로 즉시 응답
  }
}

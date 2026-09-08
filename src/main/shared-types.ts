// 렌더러 번들에서도 안전하게 import 할 수 있는 타입 재노출 (런타임 코드 없음)
export type {
  AppConfig, DirEntry, PatchRoot, Peer, SteamGame, TransferEvent, VerifySummary,
} from '../core/types.ts';
export type { InboundSession, InboundState } from '../core/inbound.ts';
export interface NodeStatusLike {
  mode: 'serving' | 'daemon-running' | 'client-only';
  addresses: string[];
  port: number;
  message: string;
}

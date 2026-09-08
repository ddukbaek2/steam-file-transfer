// 렌더러 <-> 메인 IPC 계약 (preload 가 window.sft 로 노출)
import type { InboundSession, NodeStatusLike, PatchRoot, Peer, SteamGame, VerifySummary } from './shared-types.ts';

/** 기기 하나 위의 게임 하나를 가리킨다. deviceId 는 'self' 또는 peer id */
export interface GameRef {
  deviceId: string;
  appId: string;
  root: PatchRoot;
  password?: string;
  /** 기기가 목록에서 사라졌을 때 오류 메시지에 쓸 이름 */
  deviceName?: string;
}

/** 게임 하나를 원본에서 대상으로 동기화하는 작업 요청 */
export interface TransferRequest {
  source: GameRef;
  targets: GameRef[];
  /** 화면에 보일 이름. 예: "Portal 2 → Steam Deck" */
  label: string;
  gameName: string;
  direction: 'send' | 'receive';
}

export interface TargetPlanDto {
  key: string;
  label: string;
  appId: string;
  root: PatchRoot;
  gameName?: string;
  error?: string;
  toSend: { relPath: string; size: number }[];
  skippedSame: number;
  alreadyStaged: number;
  skippedMissing: number;
  newFiles: number;
  bytes: number;
}

export type JobState = 'queued' | 'planning' | 'transferring' | 'committing' | 'verifying' | 'done' | 'failed' | 'cancelled';

/** 큐에 들어간 작업 하나의 현재 상태. 메인이 바뀔 때마다 통째로 보낸다 */
export interface JobDto {
  id: string;
  label: string;
  gameName: string;
  /** Steam 앱 ID. 목록에 게임 아이콘을 그리는 데 쓴다 */
  appId?: string;
  /** 보내는 기기 이름. 기록에서 복원한 예전 작업에는 없을 수 있다 */
  fromName?: string;
  /** 받는 기기 이름 */
  toName?: string;
  direction: 'send' | 'receive';
  state: JobState;
  /** 일시정지됨. 대기 상태로 큐에 남아 있고 재개하기 전에는 시작하지 않는다 */
  paused: boolean;
  /** 현재 단계 설명이나 전송 중인 파일 이름 */
  message: string;
  filesDone: number;
  filesTotal: number;
  doneBytes: number;
  totalBytes: number;
  targets: TargetPlanDto[];
  unreadable: { relPath: string; reason: string }[];
  verify: VerifySummary | null;
  committed: number;
  commitFailed: number;
  failedFiles: number;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface AppState {
  self: Peer;
  peers: Peer[];
  status: NodeStatusLike;
}

export interface SftApi {
  /** 'win32' | 'darwin' | 'linux' — 타이틀바 여백 등 플랫폼별 표시에 쓴다 */
  platform: string;

  getState(): Promise<AppState>;
  onPeers(cb: (peers: Peer[]) => void): void;

  /** 기기의 게임 목록. 매니페스트가 있는 게임과 폴더만 있는 것을 합친다 */
  games(deviceId: string, password?: string): Promise<SteamGame[]>;
  /** 게임 아이콘 data URL. 없으면 null */
  gameIcon(deviceId: string, appId: string, password?: string): Promise<string | null>;

  /** 작업을 큐에 넣는다. 차례가 오면 자동으로 시작된다. 작업 ID 를 돌려준다 */
  enqueue(req: TransferRequest): Promise<string>;
  /** 대기 중이면 큐에서 빼고, 진행 중이면 중단한다 */
  cancelJob(id: string): Promise<void>;
  /** 진행 중이면 파일 경계에서 멈추고 대기 상태로 돌아간다. 받아 둔 파일은 남는다 */
  pauseJob(id: string): Promise<void>;
  resumeJob(id: string): Promise<void>;
  /** 끝난 작업 하나를 기록에서 지운다 */
  removeJob(id: string): Promise<void>;
  clearFinishedJobs(): Promise<void>;
  jobs(): Promise<JobDto[]>;
  onJobs(cb: (jobs: JobDto[]) => void): void;

  /** 이 기기로 들어오는 수신 현황. 백그라운드 서비스가 받는 중이어도 보인다 */
  inbound(): Promise<InboundSession[]>;

  openPath(p: string): Promise<void>;
}

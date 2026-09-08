// 공용 타입 정의 (main / daemon / renderer 공유)

export type OsKind = 'windows' | 'macos' | 'linux' | 'steamos' | 'unknown';

export interface DeviceInfo {
  id: string;
  name: string;
  os: OsKind;
  hostname: string;
  version: string;
  port: number;
  /** 수신 시 암호가 필요한지 여부 */
  requiresPassword: boolean;
}

export interface Peer extends DeviceInfo {
  address: string;
  lastSeen: number;
  /** 자기 자신인지 */
  self: boolean;
}

export interface SteamGame {
  /** Steam 앱 ID (appmanifest 의 appid). 목록에 오르는 게임은 전부 매니페스트가 있다 */
  appId: string;
  name: string;
  installDir: string;
  /** steamapps 상위 라이브러리 경로 */
  libraryPath: string;
  /** 게임 설치 폴더 절대 경로 */
  gamePath: string;
  /** Proton prefix 의 drive_c 경로 (리눅스 + compatdata 존재 시) */
  prefixPath?: string;
  sizeOnDisk: number;
}

export type PatchRoot = 'game' | 'prefix';

export interface DirEntry {
  name: string;
  type: 'file' | 'dir';
  size: number;
}

export interface FileItem {
  /** 소스 루트 기준 상대 경로 (항상 '/' 구분자) */
  relPath: string;
  size: number;
}

export interface AppConfig {
  deviceId: string;
  deviceName: string;
  port: number;
  discoveryPort: number;
  /** 비어 있으면 인증 없음 */
  password: string;
  /** Steam 을 자동으로 못 찾을 때 직접 지정하는 루트 경로. 비어 있으면 자동 탐지 */
  steamRoot: string;
  /** 로그인 시 백그라운드로 자동 시작 (Windows/macOS). 창을 닫아도 수신은 계속된다 */
  autoStart: boolean;
}

export interface PutFileResult {
  relPath: string;
  written: boolean;
  /** 기존 파일을 바꾼 것인지 (false 면 새로 생긴 파일) */
  replaced: boolean;
  resolvedPath: string;
}

/** 세션 열기 요청: 보낼 파일 전체 목록 */
export interface SessionRequest {
  files: CheckItem[];
  /** true 면 대상에 이미 있는 파일만 받는다 (교집합) */
  onlyExisting: boolean;
}

/** 세션 열기 응답: 실제로 보내야 할 파일만 추린 결과 */
export interface SessionInfo {
  sessionId: string;
  /** 아직 받아야 하는 파일 (이미 같거나 임시 폴더에 받아 둔 것은 빠진다) */
  needed: string[];
  alreadySame: number;
  alreadyStaged: number;
  skippedMissing: number;
  newFiles: number;
}

export interface CommitResult {
  applied: number;
  failed: { relPath: string; reason: string }[];
}

export interface VerifySummary {
  same: number;
  differ: number;
  missing: number;
}

/** 전송 진행 이벤트 */
export type TransferEvent =
  | { kind: 'planning'; message: string }
  | { kind: 'planned'; summary: string }
  | { kind: 'start'; totalFiles: number; totalBytes: number }
  | { kind: 'file'; relPath: string; index: number; totalFiles: number; bytes: number; doneBytes: number; totalBytes: number; target: string }
  | { kind: 'committing'; target: string }
  | { kind: 'verifying'; target: string }
  | { kind: 'skip'; relPath: string; reason: string; target: string }
  | { kind: 'error'; relPath?: string; message: string; target: string }
  | { kind: 'done'; files: number; failed: number; bytes: number; elapsedMs: number; verify: VerifySummary | null; committed: number; commitFailed: number };

export const PROTOCOL_MAGIC = 'sft1';
export const DEFAULT_HTTP_PORT = 37021;
export const DEFAULT_DISCOVERY_PORT = 37020;
export const MULTICAST_GROUP = '239.255.42.99';

export interface CheckItem {
  relPath: string;
  size: number;
  sha256: string;
}

export interface CheckResult {
  relPath: string;
  /** 수신측에 파일이 이미 존재하는지 */
  exists: boolean;
  /** 존재하면서 해시까지 같은지 */
  same: boolean;
  size: number;
}


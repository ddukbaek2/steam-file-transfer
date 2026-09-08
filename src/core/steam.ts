// Steam 설치 경로 탐지 + 라이브러리 폴더 + 설치된 게임 목록
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseVdf, vdfObject, vdfString } from './vdf.ts';
import { loadConfig } from './config.ts';
import type { SteamGame } from './types.ts';

const execFileP = promisify(execFile);

function exists(p: string): boolean {
  try { fs.accessSync(p); return true; } catch { return false; }
}

async function windowsSteamPath(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true });
    const m = /SteamPath\s+REG_SZ\s+(.+)/i.exec(stdout);
    if (m) {
      const p = m[1].trim().replace(/\//g, '\\');
      if (exists(p)) return p;
    }
  } catch { /* ignore */ }
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Steam'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Steam'),
  ];
  return candidates.find(exists);
}

/**
 * 사용자가 직접 지정한 Steam 루트를 읽는다.
 * 환경 변수가 우선이고, 없으면 설정 파일 값을 쓴다.
 * Flatpak/Snap 설치나 비표준 경로를 쓰는 사용자를 위한 탈출구다.
 */
function overrideSteamRoot(): string | undefined {
  const fromEnv = process.env.SFT_STEAM_ROOT;
  if (fromEnv && exists(fromEnv)) return fromEnv;
  try {
    const cfg = loadConfig();
    if (cfg.steamRoot && exists(cfg.steamRoot)) return cfg.steamRoot;
  } catch { /* 설정을 못 읽으면 자동 탐지로 넘어간다 */ }
  return undefined;
}

/** Steam 클라이언트 루트 후보를 찾는다 */
export async function findSteamRoot(): Promise<string | undefined> {
  const override = overrideSteamRoot();
  if (override) return override;
  const home = os.homedir();
  if (process.platform === 'win32') return windowsSteamPath();
  if (process.platform === 'darwin') {
    const p = path.join(home, 'Library', 'Application Support', 'Steam');
    return exists(p) ? p : undefined;
  }
  const candidates = [
    path.join(home, '.local', 'share', 'Steam'),
    path.join(home, '.steam', 'steam'),
    path.join(home, '.steam', 'root'),
    path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
    path.join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam'),
  ];
  for (const c of candidates) {
    try {
      const real = fs.realpathSync(c);
      if (exists(path.join(real, 'steamapps'))) return real;
    } catch { /* ignore */ }
  }
  return undefined;
}

/** libraryfolders.vdf 를 읽어 라이브러리 루트 목록을 돌려준다 (steamapps 의 상위 폴더) */
export function readLibraryFolders(steamRoot: string): string[] {
  const libs = new Set<string>();
  libs.add(steamRoot);
  const vdfPath = [
    path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'),
    path.join(steamRoot, 'config', 'libraryfolders.vdf'),
  ].find(exists);
  if (vdfPath) {
    try {
      const root = parseVdf(fs.readFileSync(vdfPath, 'utf8'));
      const lf = vdfObject(root, 'libraryfolders') ?? root;
      for (const key of Object.keys(lf)) {
        const entry = lf[key];
        let p: string | undefined;
        if (typeof entry === 'string') p = entry; // 구형 포맷
        else p = vdfString(entry, 'path');
        if (p) {
          const norm = process.platform === 'win32' ? p.replace(/\\\\/g, '\\') : p;
          if (exists(norm)) libs.add(norm);
        }
      }
    } catch { /* 파싱 실패 시 기본 라이브러리만 */ }
  }
  return [...libs];
}

function toNumber(v: string | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 라이브러리 하나의 게임 목록.
 *
 * Steam 매니페스트(appmanifest_*.acf)가 있고 설치 폴더도 있는 게임만 넣는다.
 * steamapps/common 에 폴더만 남은 것(지운 게임의 로그·설정 잔여물)은 뺀다.
 * Steam 클라이언트가 설치된 것으로 아는 게임이어야 동기화가 의미 있기 때문이다.
 */
export function readLibraryGames(libraryPath: string): SteamGame[] {
  const steamapps = path.join(libraryPath, 'steamapps');
  const common = path.join(steamapps, 'common');
  let files: string[] = [];
  try { files = fs.readdirSync(steamapps); } catch { return []; }

  const games: SteamGame[] = [];
  for (const f of files) {
    const m = /^appmanifest_(\d+)\.acf$/i.exec(f);
    if (!m) continue;
    try {
      const acf = parseVdf(fs.readFileSync(path.join(steamapps, f), 'utf8'));
      const state = vdfObject(acf, 'AppState');
      const appId = vdfString(state, 'appid') ?? m[1];
      const name = vdfString(state, 'name') ?? `App ${appId}`;
      const installDir = vdfString(state, 'installdir');
      if (!installDir) continue;
      const gamePath = path.join(common, installDir);
      if (!exists(gamePath)) continue;
      const prefixC = path.join(steamapps, 'compatdata', appId, 'pfx', 'drive_c');
      games.push({
        appId,
        name,
        installDir,
        libraryPath,
        gamePath,
        prefixPath: process.platform === 'linux' && exists(prefixC) ? prefixC : undefined,
        sizeOnDisk: toNumber(vdfString(state, 'SizeOnDisk')),
      });
    } catch { /* 손상된 manifest 는 건너뛴다. Steam 이 고치면 다음 스캔에 나온다 */ }
  }
  return games;
}

// 게임 목록은 파일을 하나 받을 때마다 필요하다. 매번 다시 훑으면
// 라이브러리 전체 .acf 파싱과 Windows 의 reg query 자식 프로세스가 파일 수만큼 반복되어
// 실제 전송보다 스캔에 더 오래 걸린다. 짧게 캐시한다.
const CACHE_TTL_MS = 10_000;
let gameCache: { at: number; key: string; games: SteamGame[] } | null = null;

/** Steam 경로 설정이 바뀌었을 때처럼 캐시가 더 이상 맞지 않을 때 부른다 */
export function invalidateGameCache(): void {
  gameCache = null;
}

/**
 * 캐시 키. 환경 변수로 Steam 루트를 바꾸면 즉시 반영되어야 한다.
 * 설정 파일 쪽 변경은 updateConfig 가 invalidateGameCache 를 부른다.
 */
function cacheKey(): string {
  return process.env.SFT_STEAM_ROOT ?? '';
}

async function scanInstalledGames(): Promise<SteamGame[]> {
  const root = await findSteamRoot();
  if (!root) return [];
  const all: SteamGame[] = [];
  const seen = new Set<string>();
  for (const lib of readLibraryFolders(root)) {
    for (const g of readLibraryGames(lib)) {
      if (seen.has(g.appId)) continue;
      seen.add(g.appId);
      all.push(g);
    }
  }
  all.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  return all;
}

/** 이 기기에 설치된 모든 Steam 게임 */
export async function listInstalledGames(force = false): Promise<SteamGame[]> {
  const key = cacheKey();
  if (!force && gameCache && gameCache.key === key && Date.now() - gameCache.at < CACHE_TTL_MS) {
    return [...gameCache.games]; // 호출부가 목록을 바꿔도 캐시가 오염되지 않게
  }
  const games = await scanInstalledGames();
  gameCache = { at: Date.now(), key, games };
  return [...games];
}

export async function findGame(appId: string): Promise<SteamGame | undefined> {
  const hit = (await listInstalledGames()).find((g) => g.appId === appId);
  // 캐시가 살아 있는 동안 게임이 지워졌을 수 있다. 그대로 두면 지워진 폴더를
  // 새로 만들어 그 안에 패치를 쓰고는 성공했다고 보고한다.
  if (hit && exists(hit.gamePath)) return hit;
  if (!hit) return undefined;
  const fresh = (await listInstalledGames(true)).find((g) => g.appId === appId);
  return fresh && exists(fresh.gamePath) ? fresh : undefined;
}

// --- 게임 아이콘 -------------------------------------------------------
// Steam 이 캐시해 둔 이미지를 쓴다. 클라이언트 버전에 따라 두 가지 배치가 있다.
//   신형: appcache/librarycache/<appid>/<sha1>.jpg (32px 아이콘) + header.jpg, logo.png ...
//   구형: appcache/librarycache/<appid>_icon.jpg
// 아이콘이 없으면 header.jpg 라도 쓴다.

export interface GameIcon {
  mime: string;
  data: Buffer;
}

const iconCache = new Map<string, GameIcon | null>();

export async function readGameIcon(appId: string): Promise<GameIcon | null> {
  if (!/^\d+$/.test(appId)) return null;
  const hit = iconCache.get(appId);
  if (hit !== undefined) return hit;

  const root = await findSteamRoot();
  let found: GameIcon | null = null;
  if (root) {
    const lc = path.join(root, 'appcache', 'librarycache');
    const candidates: string[] = [];
    try {
      const dir = path.join(lc, appId);
      for (const f of fs.readdirSync(dir)) {
        if (/^[0-9a-f]{40}\.jpg$/i.test(f)) candidates.push(path.join(dir, f));
      }
      candidates.push(path.join(dir, 'header.jpg'));
    } catch { /* 신형 폴더 없음 */ }
    candidates.push(path.join(lc, `${appId}_icon.jpg`));
    for (const p of candidates) {
      try {
        const data = fs.readFileSync(p);
        if (data.length === 0) continue;
        found = { mime: p.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg', data };
        break;
      } catch { /* 다음 후보 */ }
    }
  }
  iconCache.set(appId, found);
  return found;
}

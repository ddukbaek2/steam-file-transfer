// Electron 메인 프로세스.
//
// 이 프로세스는 두 역할을 겸한다.
//   백그라운드 서비스: 탐색과 수신 서버를 돌린다. 창을 닫아도 살아 있고 트레이에 남는다.
//   화면(클라이언트): 필요할 때 창을 띄운다. 이미 떠 있는 서비스가 있으면 그 프로세스가 창을 연다.
// SteamOS 처럼 수신 서버가 별도 데몬(ELECTRON_RUN_AS_NODE)일 때는 화면만 담당하고,
// 수신 현황은 데몬의 /api/status 로 가져온다.
import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TransferNode } from '../core/node.ts';
import { configDir } from '../core/paths.ts';
import { listInstalledGames, readGameIcon } from '../core/steam.ts';
import { PeerClient } from '../core/client.ts';
import {
  LocalSource, LocalTarget, RemoteSource, RemoteTarget, executeTransfer, planTransfer,
  type PlanTarget, type SourceAdapter, type TargetAdapter,
} from '../core/transfer.ts';
import type { InboundSession } from '../core/inbound.ts';
import type { AppConfig, Peer, TransferEvent } from '../core/types.ts';
import type { AppState, GameRef, JobDto, TransferRequest } from './ipc-types.ts';

const isDaemonFlag = process.argv.includes('--daemon');
const node = new TransferNode();
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
const logBuffer: string[] = [];
const remoteIconCache = new Map<string, string | null>();

function send(channel: string, payload: unknown): void {
  win?.webContents.send(channel, payload);
}

node.on('log', (line: string) => {
  logBuffer.push(line);
  if (logBuffer.length > 500) logBuffer.shift();
  send('log', line);
});
node.on('peers', (peers: Peer[]) => send('peers', peers));

// --- 창 -----------------------------------------------------------------

function iconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'steamdeck', 'icon.png')
    : path.join(import.meta.dirname, '..', 'deploy', 'steamdeck', 'icon.png');
}

function createWindow(): void {
  if (win) { win.show(); win.focus(); return; }
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    title: 'Steam File Transfer',
    // 렌더러의 --bg 와 같은 값. 로드 전 배경과 창 제어 버튼 영역이 본문과 한 덩어리로 보여야 한다.
    backgroundColor: '#171d25',
    icon: fs.existsSync(iconPath()) ? iconPath() : undefined,
    // 타이틀바를 창 안으로 통합한다. Windows/Linux 는 창 제어 버튼을 겹쳐 그리고, macOS 는 신호등만 남긴다.
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 14 } }
      : { titleBarOverlay: { color: '#171d25', symbolColor: '#dfe3e8', height: 44 } }),
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  Menu.setApplicationMenu(null);
  void win.loadFile(path.join(import.meta.dirname, 'renderer', 'index.html'));
  // 창을 닫아도 서비스는 살아 있어야 한다. 종료는 트레이 메뉴에서 한다.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win?.hide();
  });
  win.on('closed', () => { win = null; });
}

function createTray(): void {
  if (tray) return;
  let image = nativeImage.createEmpty();
  try {
    image = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 });
  } catch { /* 아이콘이 없어도 트레이는 만든다 */ }
  tray = new Tray(image);
  tray.setToolTip('Steam File Transfer');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '열기', click: () => createWindow() },
    { type: 'separator' },
    { label: '종료', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => createWindow());
  tray.on('double-click', () => createWindow());
}

/** 로그인 시 백그라운드로 자동 시작. 무설치판은 원래 exe 경로를 써야 한다. */
function applyAutoStart(cfg: AppConfig): void {
  if (!app.isPackaged) return;
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  try {
    app.setLoginItemSettings({
      openAtLogin: cfg.autoStart,
      path: process.env.PORTABLE_EXECUTABLE_FILE ?? process.execPath,
      args: ['--daemon'],
    });
  } catch (e) {
    node.log(`자동 시작 설정 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- 기기/게임 ------------------------------------------------------------

function resolvePeer(deviceId: string): Peer {
  if (deviceId === 'self') return node.selfPeer();
  const p = node.peers().find((x) => x.id === deviceId);
  if (!p) throw new Error('기기를 찾을 수 없습니다 (연결이 끊겼을 수 있음)');
  return p;
}

/**
 * 연결이 끊긴 기기를 대신하는 대상.
 * 여기서 예외를 던지면 planTransfer 가 대상별로 잡아 주므로 다른 대상 결과는 정상적으로 나온다.
 */
class UnreachableTarget implements TargetAdapter {
  constructor(readonly label: string, private readonly reason: string) {}
  game(): Promise<never> { return Promise.reject(new Error(this.reason)); }
  openSession(): Promise<never> { return Promise.reject(new Error(this.reason)); }
  stage(): Promise<never> { return Promise.reject(new Error(this.reason)); }
  commit(): Promise<never> { return Promise.reject(new Error(this.reason)); }
  check(): Promise<never> { return Promise.reject(new Error(this.reason)); }
}

function makeSource(s: GameRef): SourceAdapter {
  if (s.deviceId === 'self') return new LocalSource();
  return new RemoteSource(resolvePeer(s.deviceId), s.password ?? '');
}

function makeTarget(t: GameRef): PlanTarget {
  const key = `${t.deviceId}|${t.appId}|${t.root}`;
  if (t.deviceId === 'self') return { key, adapter: new LocalTarget(), appId: t.appId, root: t.root };
  try {
    return { key, adapter: new RemoteTarget(resolvePeer(t.deviceId), t.password ?? ''), appId: t.appId, root: t.root };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { key, adapter: new UnreachableTarget(t.deviceName ?? '연결 끊긴 기기', reason), appId: t.appId, root: t.root };
  }
}

function clientFor(ref: GameRef): PeerClient {
  const p = resolvePeer(ref.deviceId);
  return new PeerClient(p.address, p.port, ref.password ?? '');
}

function toDataUrl(icon: { mime: string; data: Buffer } | null): string | null {
  return icon ? `data:${icon.mime};base64,${icon.data.toString('base64')}` : null;
}

// --- 작업 큐 --------------------------------------------------------------
// 보내기/받기는 큐에 쌓여 하나씩 처리된다. 동시에 여러 게임을 밀면 디스크와 무선이 서로 방해한다.

interface Job extends JobDto {
  /** 파일에서 복원한 끝난 작업에는 없다 */
  req?: TransferRequest;
  abort?: AbortController;
  /** 일시정지 요청으로 멈추는 중. 끝나면 실패가 아니라 대기(일시정지)로 돌아간다 */
  pausing?: boolean;
}

const jobs: Job[] = [];
let queueRunning = false;
let lastBroadcast = 0;
let broadcastTimer: NodeJS.Timeout | null = null;

function jobDto(j: Job): JobDto {
  const { req: _req, abort: _abort, pausing: _pausing, ...dto } = j;
  return dto;
}

// 전송 기록은 "완료된 항목 지우기" 를 누르기 전까지 남아야 하고, 앱을 다시 켜도 보여야 한다.
// 그래서 상태가 바뀔 때마다 파일로 쓴다. 진행률까지 매번 쓰지는 않는다.
const JOBS_FILE = path.join(configDir(), 'jobs.json');
const JOBS_KEEP = 200;
let saveTimer: NodeJS.Timeout | null = null;

function isFinished(state: JobDto['state']): boolean {
  return state === 'done' || state === 'failed' || state === 'cancelled';
}

function saveJobsNow(): void {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    fs.mkdirSync(path.dirname(JOBS_FILE), { recursive: true });
    const tmp = `${JOBS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(jobs.slice(-JOBS_KEEP).map(jobDto)), 'utf8');
    fs.renameSync(tmp, JOBS_FILE);
  } catch (e) {
    node.log(`전송 기록 저장 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function saveJobsSoon(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(saveJobsNow, 300);
}

function loadJobs(): void {
  try {
    const arr = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')) as JobDto[];
    for (const j of arr) {
      if (!isFinished(j.state)) {
        // 앱이 꺼지면서 끊긴 작업. 임시 폴더에 받아 둔 것은 남아 있으니 다시 시도하면 이어받는다.
        j.state = 'failed';
        j.message = '앱이 종료되어 중단되었습니다. 다시 시도하면 이어받습니다.';
        j.finishedAt = j.finishedAt ?? Date.now();
      }
      jobs.push({ ...j, paused: false });
    }
  } catch { /* 기록 없음 */ }
}

function broadcastJobs(force = false): void {
  const now = Date.now();
  if (!force && now - lastBroadcast < 100) {
    // 진행 이벤트는 초당 수백 번 온다. 화면은 10번이면 충분하다.
    if (!broadcastTimer) broadcastTimer = setTimeout(() => { broadcastTimer = null; broadcastJobs(true); }, 100);
    return;
  }
  lastBroadcast = now;
  send('jobs', jobs.map(jobDto));
  if (force) saveJobsSoon();
}

function enqueue(req: TransferRequest): string {
  const job: Job = {
    id: randomUUID(),
    req,
    label: req.label,
    gameName: req.gameName,
    direction: req.direction,
    state: 'queued',
    paused: false,
    message: '대기 중',
    filesDone: 0, filesTotal: 0, doneBytes: 0, totalBytes: 0,
    targets: [], unreadable: [], verify: null, committed: 0, commitFailed: 0, failedFiles: 0,
    createdAt: Date.now(),
  };
  jobs.push(job);
  broadcastJobs(true);
  void runQueue();
  return job.id;
}

async function runQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;
  try {
    for (;;) {
      // 일시정지된 작업은 건너뛰고 다음 것을 돌린다. 재개하면 다시 순서에 든다.
      const job = jobs.find((j) => j.state === 'queued' && !j.paused);
      if (!job) break;
      await runJob(job);
    }
  } finally {
    queueRunning = false;
  }
}

async function runJob(job: Job): Promise<void> {
  if (!job.req) { job.state = 'failed'; job.message = '요청 정보가 없습니다'; broadcastJobs(true); return; }
  const req = job.req;
  job.state = 'planning';
  job.startedAt = Date.now();
  job.message = '준비 중';
  job.abort = new AbortController();
  broadcastJobs(true);

  const onEvent = (ev: TransferEvent): void => {
    switch (ev.kind) {
      case 'planning': job.message = ev.message; broadcastJobs(); break;
      case 'planned': job.message = ev.summary; broadcastJobs(true); break;
      case 'start':
        job.state = 'transferring';
        job.filesTotal = ev.totalFiles;
        job.totalBytes = ev.totalBytes;
        job.message = ev.totalFiles === 0 ? '보낼 파일이 없습니다. 이미 같은 상태입니다.' : '전송 중';
        broadcastJobs(true);
        break;
      case 'file':
        job.filesDone = Math.max(job.filesDone, ev.doneBytes >= ev.bytes + (ev.doneBytes - ev.bytes) ? ev.index - 1 : ev.index - 1);
        job.doneBytes = ev.doneBytes;
        job.message = `[${ev.target}] ${ev.index}/${ev.totalFiles} ${ev.relPath}`;
        broadcastJobs();
        break;
      case 'committing': job.state = 'committing'; job.message = `[${ev.target}] 받은 파일을 제자리로 교체하는 중`; broadcastJobs(true); break;
      case 'verifying': job.state = 'verifying'; job.message = `[${ev.target}] 전체 파일이 같은지 검사하는 중`; broadcastJobs(true); break;
      case 'skip': node.log(`건너뜀 [${ev.target}]: ${ev.reason}`); break;
      case 'error': job.failedFiles++; node.log(`전송 오류 [${ev.target}] ${ev.relPath ?? ''}: ${ev.message}`); broadcastJobs(); break;
      case 'done':
        job.filesDone = ev.files;
        job.verify = ev.verify;
        job.committed = ev.committed;
        job.commitFailed = ev.commitFailed;
        job.failedFiles = ev.failed;
        break;
    }
  };

  try {
    const source = makeSource(req.source);
    const targets = req.targets.map(makeTarget);
    const plan = await planTransfer({
      source,
      sourceAppId: req.source.appId,
      sourceRoot: req.source.root,
      targets,
      onlyExisting: false,
      onProgress: (m) => onEvent({ kind: 'planning', message: m }),
    });
    job.targets = plan.targets.map((t) => ({
      key: t.key, label: t.label, appId: t.appId, root: t.root, gameName: t.gameName, error: t.error,
      toSend: t.toSend.map((f) => ({ relPath: f.relPath, size: f.size })),
      skippedSame: t.skippedSame, alreadyStaged: t.alreadyStaged, skippedMissing: t.skippedMissing,
      newFiles: t.newFiles, bytes: t.bytes,
    }));
    job.unreadable = plan.unreadable;
    onEvent({ kind: 'planned', summary: plan.targets.map((t) => t.error ? `${t.label}: ${t.error}` : `${t.label}: ${t.toSend.length}개 전송, ${t.skippedSame}개 동일`).join(' · ') });
    node.log(`동기화 시작: ${job.label}`);

    if (job.abort.signal.aborted) throw new Error('사용자가 중단했습니다');
    const result = await executeTransfer({ plan, adapters: new Map(targets.map((t) => [t.key, t])), onEvent, signal: job.abort.signal });

    const allTargetsFailed = plan.targets.length > 0 && plan.targets.every((t) => t.error);
    if (job.pausing) {
      // 일시정지: 실패가 아니라 대기로 돌아간다. 다음 실행은 새로 계획해서 받아 둔 파일을 건너뛴다.
      job.state = 'queued';
      job.paused = true;
      job.pausing = false;
      job.message = '일시정지됨. 재개하면 받아 둔 파일부터 이어받습니다.';
      node.log(`동기화 일시정지: ${job.label}`);
      return;
    }
    if (job.abort.signal.aborted) {
      job.state = 'cancelled';
      job.message = '중단됨. 받아 둔 파일은 남아 있어 다시 시도하면 이어받습니다.';
    } else if (allTargetsFailed) {
      job.state = 'failed';
      job.error = plan.targets.map((t) => t.error).join(' · ');
      job.message = job.error;
    } else if (result.failed > 0 || result.commitFailed > 0) {
      job.state = 'failed';
      job.message = `파일 ${result.failed}개를 보내지 못했거나 교체 ${result.commitFailed}개가 실패했습니다. 다시 시도하면 이어받습니다.`;
    } else {
      job.state = 'done';
      const v = result.verify;
      job.message = result.files === 0 && result.committed === 0
        ? '이미 같은 상태입니다.'
        : `완료: ${result.files}개 전송, ${result.committed}개 교체` + (v ? ` · 검증 동일 ${v.same}개${v.differ ? `, 다름 ${v.differ}개` : ''}${v.missing ? `, 없음 ${v.missing}개` : ''}` : '');
    }
    node.log(`동기화 끝: ${job.label} — ${job.message}`);
  } catch (e) {
    if (job.pausing) {
      job.state = 'queued';
      job.paused = true;
      job.pausing = false;
      job.message = '일시정지됨. 재개하면 받아 둔 파일부터 이어받습니다.';
      node.log(`동기화 일시정지: ${job.label}`);
      return;
    }
    job.state = job.abort?.signal.aborted ? 'cancelled' : 'failed';
    job.error = e instanceof Error ? e.message : String(e);
    job.message = job.error;
    node.log(`동기화 실패: ${job.label} — ${job.error}`);
  } finally {
    if (job.state !== 'queued') job.finishedAt = Date.now();
    job.abort = undefined;
    broadcastJobs(true);
  }
}

// --- 수신 현황 --------------------------------------------------------------

async function inboundList(): Promise<InboundSession[]> {
  const st = node.getStatus();
  if (st.mode === 'serving') return node.inbound.list();
  if (st.mode === 'daemon-running') {
    try {
      const r = await new PeerClient('127.0.0.1', st.port).status();
      return r.inbound;
    } catch { return []; }
  }
  return [];
}

// --- IPC --------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle('state:get', (): AppState => ({
    self: node.selfPeer(),
    peers: node.peers(),
    status: node.getStatus(),
  }));

  ipcMain.handle('games:list', async (_e, deviceId: string, password: string) => {
    if (deviceId === 'self') return listInstalledGames();
    return clientFor({ deviceId, appId: '', root: 'game', password }).games();
  });

  ipcMain.handle('games:icon', async (_e, deviceId: string, appId: string, password: string) => {
    if (deviceId === 'self') return toDataUrl(await readGameIcon(appId));
    const key = `${deviceId}|${appId}`;
    const cached = remoteIconCache.get(key);
    if (cached !== undefined) return cached;
    let url: string | null = null;
    try {
      url = toDataUrl(await clientFor({ deviceId, appId, root: 'game', password }).icon(appId));
    } catch { url = null; }
    remoteIconCache.set(key, url);
    return url;
  });

  ipcMain.handle('jobs:enqueue', (_e, req: TransferRequest) => enqueue(req));
  ipcMain.handle('jobs:cancel', (_e, id: string) => {
    const j = jobs.find((x) => x.id === id);
    if (!j) return;
    if (j.state === 'queued') {
      j.state = 'cancelled';
      j.message = '대기 중 취소됨';
      j.finishedAt = Date.now();
      broadcastJobs(true);
    } else {
      j.abort?.abort();
    }
  });
  ipcMain.handle('jobs:pause', (_e, id: string) => {
    const j = jobs.find((x) => x.id === id);
    if (!j || isFinished(j.state) || j.paused) return;
    if (j.state === 'queued') {
      j.paused = true;
      j.message = '일시정지됨';
      broadcastJobs(true);
    } else if (j.state === 'planning' || j.state === 'transferring') {
      // 교체·검증 중에는 멈추지 않는다. 짧고, 중간에 끊으면 오히려 손해다.
      j.pausing = true;
      j.message = '일시정지하는 중…';
      broadcastJobs(true);
      j.abort?.abort();
    }
  });
  ipcMain.handle('jobs:resume', (_e, id: string) => {
    const j = jobs.find((x) => x.id === id);
    if (!j || j.state !== 'queued' || !j.paused) return;
    j.paused = false;
    j.message = '대기 중';
    broadcastJobs(true);
    void runQueue();
  });
  ipcMain.handle('jobs:remove', (_e, id: string) => {
    const i = jobs.findIndex((x) => x.id === id);
    if (i < 0 || !isFinished(jobs[i].state)) return;
    jobs.splice(i, 1);
    broadcastJobs(true);
  });
  ipcMain.handle('jobs:clearFinished', () => {
    for (let i = jobs.length - 1; i >= 0; i--) {
      const s = jobs[i].state;
      if (s === 'done' || s === 'failed' || s === 'cancelled') jobs.splice(i, 1);
    }
    broadcastJobs(true);
  });
  ipcMain.handle('jobs:list', () => jobs.map(jobDto));

  ipcMain.handle('inbound:list', () => inboundList());


  ipcMain.handle('shell:openPath', async (_e, p: string) => { await shell.openPath(p); });
}

// --- 앱 생명주기 --------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 이미 서비스가 떠 있다. 그쪽에 창을 열라고 신호만 보내고 끝난다.
  app.quit();
} else {
  app.on('second-instance', () => {
    // 백그라운드로 떠 있던 서비스가 창을 연다
    createWindow();
  });

  void app.whenReady().then(async () => {
    loadJobs();
    await node.start();
    registerIpc();
    applyAutoStart(node.config);
    createTray();
    if (!isDaemonFlag) createWindow();
    app.on('activate', () => createWindow());
  });

  // 창을 다 닫아도 종료하지 않는다. 서비스는 트레이에서 계속 돈다.
  app.on('window-all-closed', () => { /* 의도적으로 비움 */ });

  app.on('before-quit', () => {
    quitting = true;
    // 방금 지우거나 바뀐 기록이 300ms 지연 저장을 기다리는 중일 수 있다. 종료 전에 바로 쓴다.
    if (saveTimer) saveJobsNow();
    void node.stop().catch(() => undefined);
  });
}

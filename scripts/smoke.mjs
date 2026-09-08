// GUI 스모크 테스트: 실제 메인 프로세스를 그대로 띄우고 화면이 그려졌는지 확인한다.
// 사용법: npm run smoke   (결과는 build/smoke/report.txt, 스크린샷은 같은 폴더)
//
// 주의: Electron 의 ESM 진입점에서 최상위 await 를 쓰면 ready 이벤트가 오지 않는다.
//       그래서 이 파일은 최상위에서 절대 await 하지 않고 프라미스 체인으로만 진행한다.
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fork } from 'node:child_process';
import os from 'node:os';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.env.SFT_SMOKE_OUT ?? path.join(projectRoot, 'build', 'smoke');
fs.mkdirSync(outDir, { recursive: true });

const lines = [];
const say = (s) => { lines.push(String(s)); console.log(s); };
const flush = () => fs.writeFileSync(path.join(outDir, 'report.txt'), lines.join('\n'), 'utf8');

const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const traceFile = path.join(outDir, 'trace.log');
fs.writeFileSync(traceFile, '');
const trace = (m) => { try { fs.appendFileSync(traceFile, `${new Date().toISOString()} ${m}\n`); } catch { /* ignore */ } };
trace('스크립트 진입');

// --- 가짜 기기 ----------------------------------------------------------
// 별도 데몬을 하나 띄워 기기 목록 2단계, 자체 메시지 상자, 덮어씌우기 전송까지 실제로 돌려 본다.
// 가짜 라이브러리에는 이 기기의 제일 작은 게임과 같은 이름의 빈 폴더(덮어씌우기 대상)와
// 이 기기에 없는 폴더 하나(받기를 누르면 "이 기기에 게임이 없습니다" 가 떠야 한다)를 둔다.
// 쓰기는 전부 임시 폴더 안에서만 일어난다. 이 기기의 실제 게임 폴더는 읽기만 한다.
const PEER_PORT = 45111;
let peer = null;

function startPeer(smallGame) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-smoke-peer-'));
  const steamRoot = path.join(base, 'Steam');
  const steamapps = path.join(steamRoot, 'steamapps');
  const common = path.join(steamapps, 'common');
  // 매니페스트가 있는 게임만 목록에 나오므로 가짜 기기에도 매니페스트를 써 준다
  const manifest = (appId, name, installDir) => fs.writeFileSync(path.join(steamapps, `appmanifest_${appId}.acf`),
    `"AppState" { "appid" "${appId}" "name" "${name}" "installdir" "${installDir}" }`);
  fs.mkdirSync(path.join(common, 'SmokeOnlyGame'), { recursive: true });
  manifest('999999901', 'SmokeOnlyGame', 'SmokeOnlyGame');
  let gameDir = null;
  if (smallGame) {
    gameDir = path.join(common, smallGame.installDir);
    fs.mkdirSync(gameDir, { recursive: true });
    manifest(smallGame.appId, smallGame.name, smallGame.installDir);
  }
  fs.writeFileSync(path.join(steamapps, 'libraryfolders.vdf'),
    `"libraryfolders" { "0" { "path" "${steamRoot.split('\\').join('\\\\')}" } }`);
  const cfg = path.join(base, 'cfg');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({
    deviceId: 'smoke-peer', deviceName: 'smoke-peer', port: PEER_PORT, discoveryPort: 37020,
    password: '', steamRoot, autoStart: false,
  }));
  const child = fork(path.join(projectRoot, 'dist', 'daemon.cjs'), [], {
    env: { ...process.env, SFT_CONFIG_DIR: cfg, SFT_STEAM_ROOT: steamRoot, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.on('data', (d) => trace(`[peer] ${String(d).trim()}`));
  child.stderr.on('data', (d) => trace(`[peer!] ${String(d).trim()}`));
  child.on('exit', (code) => trace(`[peer] 종료 code=${code}`));
  peer = { child, base, gameDir, installDir: smallGame?.installDir ?? null, gameName: smallGame?.name ?? null };
  trace(`가짜 기기 시작: ${base} (덮어씌우기 대상: ${peer.installDir ?? '없음'})`);
}

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else n++;
    }
  };
  if (dir && fs.existsSync(dir)) walk(dir);
  return n;
}

function stopPeer() {
  if (!peer) return;
  try { peer.child.kill(); } catch { /* 이미 죽음 */ }
  try { fs.rmSync(peer.base, { recursive: true, force: true }); } catch { /* 잠시 뒤 정리됨 */ }
  peer = null;
}

function finish(failed) {
  stopPeer();
  flush();
  app.quit();
  process.exit(failed ? 1 : 0);
}

process.on('uncaughtException', (e) => { say(`예외: ${e.stack}`); finish(true); });
process.on('unhandledRejection', (e) => { say(`거부된 프라미스: ${e}`); finish(true); });

async function run() {
  trace('run 시작');
  const win = await new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const tick = () => {
      const ws = BrowserWindow.getAllWindows();
      if (ws.length > 0) resolve(ws[0]);
      else if (Date.now() > deadline) reject(new Error('창이 열리지 않았습니다'));
      else setTimeout(tick, 100);
    };
    tick();
  });

  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') errors.push(`console(${e.level}): ${e.message}`);
  });
  win.webContents.on('render-process-gone', (_e, d) => errors.push(`렌더러 종료: ${d.reason}`));
  win.webContents.on('preload-error', (_e, p, err) => errors.push(`preload 오류 ${p}: ${err.message}`));

  trace('창 획득');
  // 가려진 창은 새 프레임을 그리지 않아 capturePage 가 옛 화면을 돌려준다. 앞으로 올리고 스로틀링을 끈다.
  win.webContents.setBackgroundThrottling(false);
  win.show();
  win.moveTop();
  win.focus();
  const shot = async (name) => {
    const r = await win.webContents.executeJavaScript(`new Promise((resolve) => {
      let done = false;
      requestAnimationFrame(() => requestAnimationFrame(() => { done = true; resolve('frame'); }));
      setTimeout(() => { if (!done) resolve('timeout'); }, 1500);
    })`);
    trace(`${name}: ${r}`);
    fs.writeFileSync(path.join(outDir, name), (await win.webContents.capturePage()).toPNG());
  };
  if (win.webContents.isLoading()) {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
  }
  trace('로드 완료');

  // 가짜 기기를 일찍 띄워 둔다. 다른 검사가 도는 동안 탐색에 잡힌다.
  // 덮어씌우기 대상은 이 기기에서 제일 작은 게임 (300MB 이하). 없으면 전송 검사는 건너뛴다.
  const allGames = await win.webContents.executeJavaScript(`window.sft.games('self')`);
  const small = allGames
    .filter((g) => g.sizeOnDisk > 0 && g.sizeOnDisk <= 300 * 1024 * 1024)
    .sort((a, b) => a.sizeOnDisk - b.sizeOnDisk)[0] ?? null;
  startPeer(small);

  await sleep(4000); // Steam 라이브러리 스캔과 아이콘 로드 시간

  trace('probe 시작');
  const probe = await win.webContents.executeJavaScript(`(() => {
    const t = (id) => document.getElementById(id)?.textContent?.trim() ?? null;
    const q = (sel) => document.querySelectorAll(sel).length;
    return {
      title: document.title,
      hasApi: typeof window.sft === 'object',
      platformClass: [...document.body.classList].find((c) => c.startsWith('plat-')) ?? null,
      topbarText: t('topbar'),
      topbarButtons: q('#topbar button'),
      logoIsSvg: document.querySelector('#topbar .logo')?.tagName === 'svg',
      mineHint: t('mineHint'),
      mineRows: q('#mineList .gitem'),
      mineLibs: q('#mineList .lib-head'),
      mineIcons: q('#mineList .gicon img'),
      folderButtons: q('#mineList .icon-btn[title="폴더 열기"]'),
      sendButtons: q('#mineList .icon-btn[title="다른 기기로 보내기"]'),
      overwriteInMine: q('#mineList .icon-btn[title*="덮어씁니다"]'),
      modalPick: q('#modalPick'),
      textButtonsInRows: [...document.querySelectorAll('#mineList .gacts button')].filter((b) => b.textContent.trim().length > 0).length,
      hasSearchClear: q('#mineSearch .search-clear') === 1,
      deviceCards: q('#deviceList .device'),
      selfBadges: q('#deviceList .badge.self'),
      firstDeviceIsSelf: document.querySelector('#deviceList .device .badge.self') !== null
        && document.querySelector('#deviceList .device') === document.querySelector('#deviceList .badge.self')?.closest('.device'),
      checkboxes: q('#deviceList input[type=checkbox]'),
      osBadges: q('#deviceList .badge.os'),
      ipShown: /\d+\.\d+\.\d+\.\d+/.test(document.getElementById('deviceList').textContent),
      settings: q('#btnSettings, #modalSettings, #inpAutoStart'),
      statusPill: q('#statusPill'),
      logBox: q('.logbox, #logView'),
      onlyExisting: q('#chkOnlyExisting'),
      restoreButtons: [...document.querySelectorAll('button')].filter((b) => (b.title + b.textContent).includes('되돌리기')).length,
      clearIsIcon: document.getElementById('btnClearJobs')?.classList.contains('icon-btn') === true,
      refreshIsIcon: document.getElementById('btnRefreshMine')?.classList.contains('icon-btn') === true
        && document.getElementById('btnRefreshPeers')?.classList.contains('icon-btn') === true,
      jobEmpty: t('jobList'),
      stepBadges: q('.step'),
      msgBox: q('#modalMsg'),
      bodyOverflows: document.body.scrollWidth > document.documentElement.clientWidth,
      hintTexts: [t('mineHint'), t('statusHint'), document.querySelector('#mineList .lib-head')?.textContent ?? null],
      listGeom: (() => {
        const gl = document.getElementById('mineList');
        const lh = gl.querySelector('.lib-head');
        const row = gl.querySelector('.gitem');
        if (!lh || !row) return null;
        const g = gl.getBoundingClientRect(), h = lh.getBoundingClientRect(), r = row.getBoundingClientRect();
        const b = row.querySelector('.icon-btn').getBoundingClientRect();
        return {
          dpr: devicePixelRatio, glTop: g.top, glRight: g.right, clientW: gl.clientWidth, offsetW: gl.offsetWidth,
          scrollTop: gl.scrollTop, headTop: h.top, headRight: h.right, headH: h.height, rowRight: r.right, rowH: r.height,
          btnW: b.width, btnH: b.height,
        };
      })(),
    };
  })()`);
  trace(`probe 완료: ${JSON.stringify(probe)}`);
  await shot('gui.png');

  // 검색과 지우기 버튼
  const searchResult = await win.webContents.executeJavaScript(`(async () => {
    const first = document.querySelector('#mineList .gname')?.textContent ?? '';
    const inp = document.querySelector('#mineSearch input');
    const clear = document.querySelector('#mineSearch .search-clear');
    const clearHiddenBefore = clear.hidden;
    inp.value = first.slice(0, 3);
    inp.dispatchEvent(new Event('input'));
    const shown = document.querySelectorAll('#mineList .gitem').length;
    const clearVisible = !clear.hidden;
    clear.click();
    const restored = document.querySelectorAll('#mineList .gitem').length;
    return { first, shown, clearHiddenBefore, clearVisible, restored, valueAfter: inp.value };
  })()`);

  // 기기 목록의 "이 기기" 는 눌러도 아무 일 없다 (자기 자신에게 보낼 일이 없으니 2단계가 없다)
  const selfClick = await win.webContents.executeJavaScript(`(async () => {
    const before = document.querySelectorAll('#deviceList .device').length;
    document.querySelector('#deviceList .device.self')?.click();
    await new Promise((r) => setTimeout(r, 300));
    return {
      before,
      after: document.querySelectorAll('#deviceList .device').length,
      nav: document.querySelectorAll('#deviceList .device-nav').length,
      rows: document.querySelectorAll('#deviceList .gitem').length,
      chevOnSelf: document.querySelectorAll('#deviceList .device.self .chev').length,
      buttonsOnSelf: document.querySelectorAll('#deviceList .device.self button').length,
    };
  })()`);
  await shot('gui-self-clicked.png');

  // 패널 크기 조절 손잡이: 끄는 동안만 표시되고, 비율이 바뀌고, 기억되고, 더블클릭으로 돌아온다
  const splitResult = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const layout = document.querySelector('.layout');
    const v = document.querySelector('.split-v');
    const h = document.querySelector('.split-h');
    const val = (name) => parseFloat(getComputedStyle(layout).getPropertyValue(name));
    const fire = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse',
    }));
    const r = v.getBoundingClientRect();
    const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
    const before = val('--split-x');
    const idleOpacity = parseFloat(getComputedStyle(v, '::after').opacity);
    fire(v, 'pointerdown', x0, y0);
    const activeDuring = v.classList.contains('active') && document.body.classList.contains('resizing-x');
    await wait(400); // 색이 드는 전환(0.15s)이 끝날 때까지
    const activeOpacity = parseFloat(getComputedStyle(v, '::after').opacity);
    fire(window, 'pointermove', x0 + 150, y0);
    const during = val('--split-x');
    fire(window, 'pointerup', x0 + 150, y0);
    const activeAfter = v.classList.contains('active') || document.body.classList.contains('resizing-x');
    const samples = [];
    for (let i = 0; i < 8; i++) {
      await wait(100);
      samples.push(+parseFloat(getComputedStyle(v, '::after').opacity).toFixed(2));
    }
    const afterOpacity = samples[samples.length - 1];
    const hovered = v.matches(':hover');
    const visibility = document.visibilityState;
    const focused = document.hasFocus();
    const leftWidth = document.getElementById('panelMine').getBoundingClientRect().width;
    const rightWidth = document.getElementById('panelDevices').getBoundingClientRect().width;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('sft.layout')); } catch { /* 없음 */ }
    v.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const restored = val('--split-x');
    return {
      splitters: document.querySelectorAll('.layout .splitter').length,
      hasH: !!h, before, during, restored, activeDuring, activeAfter, idleOpacity, activeOpacity, afterOpacity,
      samples, hovered, visibility, focused,
      leftWidth, rightWidth, saved,
    };
  })()`);

  // 잡고 있는 상태의 스크린샷 (손잡이에 색이 들어오는지 눈으로 확인용)
  await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.split-h');
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, pointerId: 1, pointerType: 'mouse',
    }));
  })()`);
  await sleep(400);
  await shot('gui-dragging.png');
  await win.webContents.executeJavaScript(`window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1, pointerType: 'mouse' }))`);

  // 전송 상태 항목별 제어: 없는 기기로 넣은 작업은 실패로 끝나고, 끝난 항목엔 제거 버튼만 있으며, 누르면 기록에서 사라진다
  const jobCtl = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // 지난 스모크가 남긴 항목이 있으면 먼저 치운다
    for (const j of await window.sft.jobs()) {
      if (j.label.startsWith('스모크') || j.label.includes('smoke-peer')) await window.sft.removeJob(j.id);
    }
    // 준비 단계가 원본 해시 계산이라 제일 작은 게임을 고른다
    const games = await window.sft.games('self');
    const g = [...games].sort((a, b) => (a.sizeOnDisk || Infinity) - (b.sizeOnDisk || Infinity))[0];
    if (!g) return { skipped: true };
    const id = await window.sft.enqueue({
      source: { deviceId: 'self', appId: g.appId, root: 'game' },
      targets: [{ deviceId: 'smoke-nope', appId: g.appId, root: 'game', deviceName: '없는 기기' }],
      label: '스모크 → 없는 기기', gameName: g.name, direction: 'send',
    });
    let job = null;
    for (let i = 0; i < 200; i++) {
      await wait(200);
      job = (await window.sft.jobs()).find((j) => j.id === id);
      if (job && ['done', 'failed', 'cancelled'].includes(job.state)) break;
    }
    await wait(400);
    const row = [...document.querySelectorAll('#jobList .job')].find((r) => r.querySelector('.jlabel')?.textContent.includes('스모크'));
    const btns = row ? [...row.querySelectorAll('.jacts .icon-btn')].map((b) => b.title) : [];
    row?.querySelector('.icon-btn[title="기록에서 제거"]')?.click();
    await wait(400);
    const remaining = (await window.sft.jobs()).some((j) => j.id === id);
    const rowGone = ![...document.querySelectorAll('#jobList .jlabel')].some((l) => l.textContent.includes('스모크'));
    return { skipped: false, state: job?.state, message: job?.message, shown: !!row, btns, remaining, rowGone };
  })()`);

  // --- 가짜 기기로 2단계·메시지 상자·덮어씌우기 ---
  // 기기 목록에 나타날 때까지 기다린다
  let peerSeen = false;
  for (let i = 0; i < 100 && !peerSeen; i++) {
    peerSeen = await win.webContents.executeJavaScript(`window.sft.getState().then((s) => s.peers.some((p) => p.id === 'smoke-peer'))`);
    if (!peerSeen) await sleep(300);
  }
  await sleep(500); // 화면 갱신(4초 주기)이 아니라 onPeers 로 바로 그려지지만 여유를 둔다
  await shot('gui-devices.png');

  const peerTest = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const row = [...document.querySelectorAll('#deviceList .device')].find((r) => r.querySelector('.dname')?.textContent === 'smoke-peer');
    if (!row) return { found: false };
    row.click();
    let games = 0;
    for (let i = 0; i < 100; i++) {
      await wait(200);
      games = document.querySelectorAll('#deviceList .gitem').length;
      if (games > 0) break;
    }
    return {
      found: true, games,
      nav: document.querySelectorAll('#deviceList .device-nav').length,
      navName: document.querySelector('#deviceList .device-nav .dname')?.textContent ?? null,
      receive: document.querySelectorAll('#deviceList .gitem .icon-btn[title="이 기기로 받기"]').length,
      overwrite: document.querySelectorAll('#deviceList .gitem .icon-btn[title*="덮어씁니다"]').length,
      folder: document.querySelectorAll('#deviceList .gitem .icon-btn[title="폴더 열기"]').length,
      overwriteTitle: document.querySelector('#deviceList .gitem .icon-btn[title*="덮어씁니다"]')?.title ?? null,
      deviceRows: document.querySelectorAll('#deviceList .device').length,
    };
  })()`);
  await shot('gui-peer-games.png');

  // 이 기기에 없는 게임을 받으려 하면 OS 대화상자가 아니라 자체 메시지 상자
  const msgOpen = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const row = [...document.querySelectorAll('#deviceList .gitem')].find((r) => r.querySelector('.gname')?.textContent === 'SmokeOnlyGame');
    if (!row) return { found: false };
    row.querySelector('.icon-btn[title="이 기기로 받기"]').click();
    await wait(400);
    return { found: true, open: !document.getElementById('modalMsg').hidden, title: document.getElementById('msgTitle').textContent };
  })()`);
  await shot('gui-msgbox.png');
  const msgClosed = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('#msgButtons button')?.click();
    await new Promise((r) => setTimeout(r, 150));
    return document.getElementById('modalMsg').hidden;
  })()`);

  // 덮어씌우기: 이 기기의 제일 작은 게임을 가짜 기기의 빈 폴더로. 파일이 실제로 도착해야 한다.
  let xfer = null;
  if (peer?.installDir) {
    const clicked = await win.webContents.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll('#deviceList .gitem')].find((r) => r.querySelector('.gname')?.textContent === ${JSON.stringify(peer.gameName)});
      if (!row) return false;
      row.querySelector('.icon-btn[title*="덮어씁니다"]').click();
      return true;
    })()`);
    await sleep(2500);
    await shot('gui-transferring.png');
    xfer = clicked ? await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      let job = null;
      for (let i = 0; i < 600; i++) {
        const js = await window.sft.jobs();
        job = js.find((j) => j.label.endsWith('→ smoke-peer'));
        if (job && ['done', 'failed', 'cancelled'].includes(job.state)) break;
        await wait(250);
      }
      const row = [...document.querySelectorAll('#jobList .job')].find((r) => r.querySelector('.jlabel')?.textContent.includes('smoke-peer'));
      return job ? {
        state: job.state, message: job.message, filesDone: job.filesDone, filesTotal: job.filesTotal,
        committed: job.committed, failedFiles: job.failedFiles, verify: job.verify,
        rowButtons: row ? [...row.querySelectorAll('.jacts .icon-btn')].map((b) => b.title) : [],
      } : { state: 'missing' };
    })()`) : { state: 'no-row' };
    xfer.diskFiles = countFiles(peer.gameDir);
    // 교체가 끝나면 임시 폴더에 파일이 남아 있으면 안 된다 (빈 폴더는 상관없다)
    xfer.stagingLeft = countFiles(path.join(peer.base, 'Steam', 'steamapps', '.sft-staging'));
    await sleep(300);
    await shot('gui-transferred.png');
  }

  // 뒤로 가기로 1단계 복귀
  const backTest = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('#deviceList .device-nav .icon-btn[title="기기 목록으로"]')?.click();
    await new Promise((r) => setTimeout(r, 200));
    return { nav: document.querySelectorAll('#deviceList .device-nav').length, devices: document.querySelectorAll('#deviceList .device').length };
  })()`);

  // 이 기기의 기록에 남은 스모크 작업은 지운다 (실제 기록 파일을 같이 쓰므로)
  await win.webContents.executeJavaScript(`(async () => {
    for (const j of await window.sft.jobs()) {
      if (!j.label.includes('smoke-peer') && !j.label.startsWith('스모크')) continue;
      if (!['done', 'failed', 'cancelled'].includes(j.state)) { await window.sft.cancelJob(j.id); await new Promise((r) => setTimeout(r, 500)); }
      await window.sft.removeJob(j.id);
    }
  })()`);
  await sleep(700); // 기록 파일 저장은 300ms 뒤에 몰아서 한다. 그 전에 끝내면 지운 게 되살아난다.

  const gameCount = await win.webContents.executeJavaScript(`window.sft.games('self').then((g) => g.length)`);
  const jobs = await win.webContents.executeJavaScript(`window.sft.jobs()`);
  await sleep(300);
  const jobListText = await win.webContents.executeJavaScript(`document.getElementById('jobList').textContent.trim()`);
  const inbound = await win.webContents.executeJavaScript(`window.sft.inbound()`);

  const checks = [
    ['창 제목', probe.title === 'Steam File Transfer'],
    ['preload API 노출', probe.hasApi === true],
    ['타이틀바는 로고와 제목만', probe.topbarText === 'Steam File Transfer' && probe.topbarButtons === 0 && probe.logoIsSvg],
    ['상태 표시등 없음', probe.statusPill === 0],
    ['설정 없음', probe.settings === 0],
    ['활동 기록 없음', probe.logBox === 0],
    ['덮어쓰기 옵션 없음', probe.onlyExisting === 0],
    ['되돌리기 없음', probe.restoreButtons === 0],
    ['단계 번호 배지 없음', probe.stepBadges === 0],
    ['게임 목록 렌더 (IPC 개수와 일치)', probe.mineRows === gameCount],
    ['라이브러리 그룹 헤더', gameCount === 0 || probe.mineLibs >= 1],
    ['게임 아이콘 로드', gameCount === 0 || probe.mineIcons >= 1],
    ['행 버튼은 폴더 열기 아이콘 하나뿐', probe.folderButtons === gameCount && probe.sendButtons === 0 && probe.overwriteInMine === 0 && probe.textButtonsInRows === 0],
    ['개수 표시 없음', probe.hintTexts[0] === '' && probe.hintTexts[1] === '' && !/\d+개/.test(probe.hintTexts[2] ?? '')],
    ['기기 고르기 모달 없음', probe.modalPick === 0],
    ['새로고침·지우기도 아이콘', probe.refreshIsIcon && probe.clearIsIcon],
    ['검색 지우기 버튼', probe.hasSearchClear && searchResult.clearHiddenBefore && (gameCount === 0 || (searchResult.clearVisible && searchResult.restored === gameCount && searchResult.valueAfter === ''))],
    ['기기 목록 맨 위가 이 기기', probe.selfBadges === 1 && probe.firstDeviceIsSelf],
    ['이 기기는 눌러도 2단계 없음', selfClick.before === selfClick.after && selfClick.nav === 0 && selfClick.rows === 0 && selfClick.chevOnSelf === 0 && selfClick.buttonsOnSelf === 0],
    ['기기 체크박스 없음', probe.checkboxes === 0],
    ['기기 행마다 OS 배지, 주소는 없음', probe.osBadges === probe.deviceCards && probe.ipShown === false],
    ['패널 손잡이 둘, 평소엔 안 보임', splitResult.splitters === 2 && splitResult.hasH && splitResult.idleOpacity === 0],
    ['잡는 동안만 색이 들고 놓으면 사라짐', splitResult.activeDuring && splitResult.activeOpacity === 1 && splitResult.activeAfter === false && splitResult.afterOpacity === 0],
    ['끌면 비율이 바뀌고 왼쪽이 넓어짐', splitResult.during > splitResult.before && splitResult.leftWidth > splitResult.rightWidth],
    ['비율 기억 후 더블클릭으로 복귀', splitResult.saved?.x > 0.5 && splitResult.restored === 0.5],
    ['자체 메시지 상자 존재', probe.msgBox === 1],
    ['작업 큐 비어 있음 안내', jobs.length > 0 || jobListText.includes('받기나 덮어씌우기')],
    ['작업 큐/수신 IPC', Array.isArray(jobs) && Array.isArray(inbound)],
    ['끝난 작업엔 제거 버튼만, 누르면 기록에서 사라짐', jobCtl.skipped || (jobCtl.state === 'failed' && jobCtl.shown && jobCtl.btns.length === 1 && jobCtl.btns[0] === '기록에서 제거' && jobCtl.remaining === false && jobCtl.rowGone)],
    ['가짜 기기가 기기 목록에 나타남', peerSeen && peerTest.found],
    ['기기를 누르면 2단계 (뒤로 가기 + 이름 + 게임 목록)', peerTest.found && peerTest.nav === 1 && peerTest.navName === 'smoke-peer' && peerTest.games >= 1 && peerTest.deviceRows === 0],
    ['2단계 행엔 받기·덮어씌우기만 (폴더 열기 없음)', peerTest.found && peerTest.receive === peerTest.games && peerTest.overwrite === peerTest.games && peerTest.folder === 0],
    ['덮어씌우기 툴팁 문구', (peerTest.overwriteTitle ?? '').includes('현재 기기의 파일을 smoke-peer 에 덮어씁니다')],
    ['없는 게임 받기 → 자체 메시지 상자', msgOpen.found && msgOpen.open && msgOpen.title === '이 기기에 게임이 없습니다' && msgClosed === true],
    ['덮어씌우기 전송 완료 (파일 도착·교체·검증)', xfer === null || (xfer.state === 'done' && xfer.diskFiles > 0 && xfer.committed === xfer.diskFiles && xfer.failedFiles === 0 && xfer.verify?.differ === 0 && xfer.stagingLeft === 0)],
    ['끝난 전송 항목엔 제거 버튼', xfer === null || (xfer.rowButtons?.length === 1 && xfer.rowButtons[0] === '기록에서 제거')],
    ['뒤로 가기로 1단계 복귀', backTest.nav === 0 && backTest.devices >= 2],
    ['가로 스크롤 없음', probe.bodyOverflows === false],
    ['스크린샷 저장', fs.statSync(path.join(outDir, 'gui.png')).size > 10000],
  ];

  say(JSON.stringify({ probe, searchResult, selfClick, splitResult, jobCtl, peerSeen, peerTest, msgOpen, msgClosed, xfer, backTest, gameCount, jobs, inbound, errors }, null, 2));
  say('');
  let failed = false;
  for (const [name, ok] of checks) {
    say(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}`);
    if (!ok) failed = true;
  }
  if (errors.length > 0) {
    failed = true;
    say(`\n렌더러 오류 ${errors.length}건`);
    for (const e of errors) say(`  ${e}`);
  }
  say(failed ? '\n=== 실패 ===' : `\n=== 전부 통과 === (스크린샷: ${outDir})`);
  finish(failed);
}

import(pathToFileURL(path.join(projectRoot, 'dist', 'main.js')).href)
  .then(() => { trace('main.js 로드 완료'); return app.whenReady(); })
  .then(() => { trace('app ready'); return run(); })
  .catch((e) => { say(`실행 실패: ${e.stack ?? e}`); finish(true); });

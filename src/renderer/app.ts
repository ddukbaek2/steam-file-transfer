// 렌더러 UI. preload 가 노출한 window.sft 만 사용한다 (Node API 접근 없음)
//
// 화면은 셋이다. 설정은 없다. 알아서 돌아가야 한다.
//   게임 목록   : 이 기기의 게임. 항목엔 폴더 열기뿐이다. 전송은 여기서 하지 않는다.
//   기기 목록   : 2단계 화면. 1단계는 기기 행(맨 위 이 기기는 표시만). 다른 기기를 누르면 2단계인 그 기기의
//                 게임 목록으로 들어가고, 항목의 보내기(이 기기 → 그 기기)로 전송한다.
//   전송 상태   : 큐에 쌓인 작업과 들어오는 수신. 항목마다 일시정지·재개·취소·제거.
import type { InboundSession, Peer, SteamGame } from '../main/shared-types.ts';
import type { AppState, JobDto, SftApi, TransferRequest } from '../main/ipc-types.ts';

declare global {
  interface Window { sft: SftApi }
}
const sft = window.sft;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

const OS_LABEL: Record<string, string> = {
  windows: 'Windows', macos: 'macOS', linux: 'Linux', steamos: 'SteamOS', unknown: '알 수 없음',
};

const JOB_STATE_LABEL: Record<JobDto['state'], string> = {
  queued: '대기', planning: '준비', transferring: '전송 중', committing: '교체 중', verifying: '검증 중',
  done: '완료', failed: '실패', cancelled: '중단됨',
};

// --- 아이콘 버튼 (툴팁은 title 로) ---------------------------------------
const ICONS = {
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  // 보내기: 선 위로 나가는 화살표 (내려받기 아이콘과 대칭)
  upload: 'M12 19V7m0 0l-5 5m5-5l5 5M5 4h14',
  close: 'M6 6l12 12M18 6L6 18',
  back: 'M15 5l-7 7 7 7',
  pause: 'M9 5v14M15 5v14',
  play: 'M8 5l11 7-11 7z',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
};

/** 단색 선 아이콘. 색은 currentColor 를 따른다 */
function svgIcon(d: string, size: number): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '2');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
}

function iconBtn(kind: keyof typeof ICONS, title: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = `icon-btn ${cls}`.trim();
  b.title = title;
  b.setAttribute('aria-label', title);
  b.append(svgIcon(ICONS[kind], 18));
  b.onclick = (e) => { e.stopPropagation(); onClick(); };
  return b;
}

// OS 표시: "이 기기" 배지와 같은 모양의 알약에 작은 단색 그림. 주소는 보여 주지 않는다.
const OS_ICONS: Record<string, string> = {
  windows: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  steamos: 'M7 8h10a4 4 0 0 1 4 4v3a2.5 2.5 0 0 1-4.6 1.4L15 14H9l-1.4 2.4A2.5 2.5 0 0 1 3 15v-3a4 4 0 0 1 4-4zM8 11v3M6.5 12.5h3M16 11.5h.01M18 13.5h.01',
  macos: 'M4 6h16v10H4zM2 19h20',
  linux: 'M4 5h16v14H4zM8 9l3 3-3 3M13 15h4',
  unknown: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.7M12 17h.01',
};

function osBadge(os: string): HTMLElement {
  const b = document.createElement('span');
  b.className = 'badge os';
  const label = OS_LABEL[os] ?? os;
  b.title = label;
  b.append(svgIcon(OS_ICONS[os] ?? OS_ICONS.unknown, 11), label);
  return b;
}

/** 검색 상자. 글자가 있으면 오른쪽에 지우기 버튼이 나타난다. Escape 로도 지운다. */
function searchBox(value: string, placeholder: string, onChange: (v: string) => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'search-wrap';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'search';
  input.placeholder = placeholder;
  input.value = value;
  input.autocomplete = 'off';
  const sync = (): void => { clear.hidden = input.value.length === 0; };
  const clear = iconBtn('close', '지우기', () => { input.value = ''; onChange(''); sync(); input.focus(); }, 'search-clear');
  input.oninput = () => { onChange(input.value); sync(); };
  input.onclick = (e) => e.stopPropagation();
  input.onkeydown = (e) => { if (e.key === 'Escape' && input.value) { input.value = ''; onChange(''); sync(); } };
  sync();
  wrap.append(input, clear);
  return wrap;
}

function textBtn(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = label;
  b.onclick = (e) => { e.stopPropagation(); onClick(); };
  return b;
}

// --- 상태 -------------------------------------------------------------
interface DeviceView {
  games: SteamGame[] | null;
  loading: boolean;
  error?: string;
  search: string;
}

const state = {
  self: null as Peer | null,
  peers: [] as Peer[],
  status: null as AppState['status'] | null,
  mine: [] as SteamGame[],
  mineLoaded: false,
  mineSearch: '',
  devices: new Map<string, DeviceView>(),
  openDevice: null as string | null, // 2단계로 들어가 있는 기기
  jobs: [] as JobDto[],
  inbound: [] as InboundSession[],
};

const iconCache = new Map<string, Promise<string | null>>();

function viewFor(id: string): DeviceView {
  let v = state.devices.get(id);
  if (!v) {
    v = { games: null, loading: false, search: '' };
    state.devices.set(id, v);
  }
  return v;
}

function jobsActive(): boolean {
  return state.jobs.some((j) => j.state !== 'done' && j.state !== 'failed' && j.state !== 'cancelled');
}

// --- 공용: 게임 목록 그리기 -------------------------------------------

interface GameListOptions {
  deviceId: string;
  games: SteamGame[];
  search: string;
  actions: (g: SteamGame) => HTMLElement[];
}

function loadIcon(deviceId: string, g: SteamGame, into: HTMLElement): void {
  loadIconById(deviceId, g.appId, into);
}

/** 앱 ID 만 아는 곳(전송 상태 항목)에서도 아이콘을 그린다 */
function loadIconById(deviceId: string, appId: string, into: HTMLElement): void {
  const key = `${deviceId}|${appId}`;
  let p = iconCache.get(key);
  if (!p) {
    p = sft.gameIcon(deviceId, appId).catch(() => null);
    iconCache.set(key, p);
  }
  void p.then((url) => {
    if (!url || !into.isConnected) return;
    const img = document.createElement('img');
    img.alt = '';
    img.src = url;
    into.replaceChildren(img);
  });
}

function renderGameList(container: HTMLElement, o: GameListOptions): void {
  container.replaceChildren();
  const q = o.search.trim().toLowerCase();
  const shown = q
    ? o.games.filter((g) => g.name.toLowerCase().includes(q) || g.installDir.toLowerCase().includes(q) || g.appId === q)
    : o.games;

  if (o.games.length === 0) {
    container.innerHTML = '<div class="empty">Steam 게임을 찾지 못했습니다. 이 기기에 Steam 이 설치되어 있는지 확인하세요.</div>';
    return;
  }
  if (shown.length === 0) {
    container.innerHTML = '<div class="empty">일치하는 게임이 없습니다.</div>';
    return;
  }

  // 라이브러리별로 묶는다. Steam 은 라이브러리 루트를 여러 개 둘 수 있다.
  const byLib = new Map<string, SteamGame[]>();
  for (const g of shown) {
    const arr = byLib.get(g.libraryPath) ?? [];
    arr.push(g);
    byLib.set(g.libraryPath, arr);
  }

  for (const [lib, arr] of byLib) {
    const head = document.createElement('div');
    head.className = 'lib-head';
    head.title = lib;
    head.textContent = lib;
    container.append(head);

    for (const g of arr) {
      const row = document.createElement('div');
      row.className = 'gitem';

      const icon = document.createElement('div');
      icon.className = 'gicon';
      icon.textContent = (g.name.trim()[0] ?? '?').toUpperCase();
      loadIcon(o.deviceId, g, icon);

      const main = document.createElement('div');
      main.className = 'gmain';
      const name = document.createElement('div');
      name.className = 'gname';
      name.textContent = g.name;
      name.title = g.name;
      const sub = document.createElement('div');
      sub.className = 'gsub';
      sub.textContent = g.gamePath;
      sub.title = g.gamePath;
      main.append(name, sub);

      const acts = document.createElement('div');
      acts.className = 'gacts';
      acts.append(...o.actions(g));

      row.append(icon, main, acts);
      container.append(row);
    }
  }
}

/** 게임 목록 행에 붙는 버튼: 폴더 열기뿐. 전송은 기기 목록 쪽 행에서 한다 */
function mineActions(g: SteamGame): HTMLElement[] {
  return [iconBtn('folder', '폴더 열기', () => void sft.openPath(g.gamePath))];
}

// --- 게임 목록 (이 기기) -------------------------------------------------

async function loadMine(): Promise<void> {
  $('mineList').innerHTML = '<div class="empty">Steam 라이브러리를 읽는 중…</div>';
  $('mineHint').textContent = '';
  try {
    state.mine = await sft.games('self');
    state.mineLoaded = true;
  } catch (e) {
    state.mine = [];
    $('mineList').innerHTML = '<div class="empty">게임 목록을 불러오지 못했습니다.</div>';
    $('mineHint').textContent = errText(e);
    return;
  }
  renderMine();
}

function renderMine(): void {
  $('mineHint').textContent = '';
  renderGameList($('mineList'), { deviceId: 'self', games: state.mine, search: state.mineSearch, actions: mineActions });
}

// --- 기기 목록 ---------------------------------------------------------
// 1단계: 기기 행 (이 기기가 맨 위, 누를 수 없음). 2단계: 고른 기기의 게임 목록.
// 접었다 펴는 방식이 아니라 화면을 바꿔 들어가고, 뒤로 가기로 나온다.

/** 이 기기가 맨 위, 그 아래 다른 기기 */
function allDevices(): Peer[] {
  const all: Peer[] = [];
  if (state.self) all.push({ ...state.self, self: true });
  all.push(...state.peers);
  return all;
}

function deviceKey(p: Peer): string {
  return p.self ? 'self' : p.id;
}

/** 마지막으로 그린 기기 목록의 서명. 같은 내용을 다시 그리지 않기 위한 값이다. */
let lastRenderedSignature = '';

function deviceSignature(): string {
  return allDevices().map((p) => `${deviceKey(p)}:${p.name}:${p.address}`).join('|');
}

function renderDevices(): void {
  const list = $('deviceList');
  const all = allDevices();
  lastRenderedSignature = deviceSignature();

  // 사라진 기기는 상태에서도 뺀다
  const alive = new Set(all.map(deviceKey));
  for (const key of [...state.devices.keys()]) if (!alive.has(key)) state.devices.delete(key);

  $('peerHint').textContent = state.peers.length === 0 ? '다른 기기를 찾는 중…' : '';
  list.replaceChildren();

  // 2단계: 보고 있던 기기가 아직 있으면 그 기기의 게임 목록
  const open = state.openDevice ? state.peers.find((p) => p.id === state.openDevice) : undefined;
  if (state.openDevice && !open) state.openDevice = null;
  if (open) {
    renderDeviceGames(list, open);
    return;
  }

  for (const p of all) {
    const row = document.createElement('div');
    row.className = p.self ? 'device self' : 'device';
    const nm = document.createElement('span');
    nm.className = 'dname';
    nm.textContent = p.name || p.hostname;
    row.append(nm, osBadge(p.os));
    if (p.self) {
      const b = document.createElement('span');
      b.className = 'badge self';
      b.textContent = '이 기기';
      row.append(b);
    } else {
      const chev = document.createElement('span');
      chev.className = 'chev';
      chev.textContent = '›';
      row.append(chev);
      row.title = `${p.name} 의 게임 목록`;
      row.onclick = () => void openDevice(p);
    }
    list.append(row);
  }

  if (state.peers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = '아직 다른 기기가 보이지 않습니다.<br />같은 공유기에 연결된 기기에서 이 앱이 켜져 있으면 몇 초 안에 나타납니다.';
    list.append(empty);
  }
}

/** 2단계: 기기 하나의 게임 목록. 맨 위에 뒤로 가기와 기기 이름 */
function renderDeviceGames(list: HTMLElement, p: Peer): void {
  const v = viewFor(deviceKey(p));

  const nav = document.createElement('div');
  nav.className = 'device-nav';
  const nm = document.createElement('span');
  nm.className = 'dname';
  nm.textContent = p.name || p.hostname;
  nav.append(iconBtn('back', '기기 목록으로', () => { state.openDevice = null; renderDevices(); }), nm, osBadge(p.os));
  list.append(nav);

  if (v.loading && !v.games) {
    const h = document.createElement('div');
    h.className = 'hint';
    h.textContent = '게임 목록을 불러오는 중…';
    list.append(h);
  } else if (v.error && !v.games) {
    const h = document.createElement('div');
    h.className = 'hint';
    h.style.color = 'var(--err)';
    h.textContent = v.error;
    list.append(h, textBtn('다시 시도', 'ghost small', () => void loadDeviceGames(p)));
  } else if (v.games) {
    const listEl = document.createElement('div');
    listEl.className = 'gamelist';
    const draw = (): void => renderGameList(listEl, {
      deviceId: p.id,
      games: v.games ?? [],
      search: v.search,
      // 이 기기의 파일을 그 기기에 쓴다. 반대 방향은 그 기기에서 하면 된다.
      actions: (g) => [
        iconBtn('upload', `현재 기기의 파일을 ${p.name} 에 덮어씁니다`, () => void overwriteTo(p, g), 'primary'),
      ],
    });
    list.append(searchBox(v.search, '게임 이름으로 검색', (val) => { v.search = val; draw(); }), listEl);
    draw();
  }
}

async function openDevice(p: Peer): Promise<void> {
  if (p.self) return;
  state.openDevice = p.id;
  renderDevices();
  const v = viewFor(deviceKey(p));
  if (!v.loading) await loadDeviceGames(p);
}

async function loadDeviceGames(p: Peer): Promise<void> {
  const v = viewFor(deviceKey(p));
  v.loading = true;
  v.error = undefined;
  renderDevices();
  try {
    v.games = await sft.games(p.id);
  } catch (e) {
    v.error = errText(e);
  } finally {
    v.loading = false;
    renderDevices();
  }
}

// --- 게임 매칭 ---------------------------------------------------------

/** 같은 게임 찾기. 진짜 Steam ID 가 같거나, 폴더 이름이 같으면 같은 게임으로 본다 */
function findMatch(games: SteamGame[] | null, target: SteamGame): SteamGame | undefined {
  if (!games) return undefined;
  return games.find((g) => g.appId === target.appId);
}

// --- 보내기 -------------------------------------------------------------

/** 이 기기의 파일로 그 기기의 같은 게임을 덮어쓴다 */
async function overwriteTo(p: Peer, g: SteamGame): Promise<void> {
  if (!state.mineLoaded) await loadMine();
  const mine = findMatch(state.mine, g);
  if (!mine) {
    await msgBox('이 기기에 게임이 없습니다', `"${g.name}" 이(가) 이 기기에 없어 보낼 파일이 없습니다.`);
    return;
  }
  await enqueue({
    source: { deviceId: 'self', appId: mine.appId, root: 'game', deviceName: state.self?.name ?? '이 기기' },
    targets: [{ deviceId: p.id, appId: g.appId, root: 'game', deviceName: p.name }],
    label: `${g.name} → ${p.name}`,
    gameName: g.name,
    direction: 'send',
  });
}

async function enqueue(req: TransferRequest): Promise<void> {
  try {
    await sft.enqueue(req);
  } catch (e) {
    await msgBox('작업을 추가하지 못했습니다', errText(e));
  }
}

// --- 전송 상태 ---------------------------------------------------------

function renderJobs(): void {
  const list = $('jobList');
  list.replaceChildren();
  if (state.jobs.length === 0) {
    list.innerHTML = '<div class="empty">기기 목록에서 보내기를 누르면 여기에 쌓여 차례로 진행됩니다.</div>';
    return;
  }

  // 진행 중인 것이 위, 그다음 대기, 끝난 것은 최근 순
  const order: Record<JobDto['state'], number> = { transferring: 0, committing: 0, verifying: 0, planning: 0, queued: 1, failed: 2, cancelled: 2, done: 3 };
  const sorted = [...state.jobs].sort((a, b) => (order[a.state] - order[b.state]) || (b.createdAt - a.createdAt));

  for (const j of sorted) {
    const row = document.createElement('div');
    row.className = `job ${j.state}`;
    row.dataset.jobId = j.id;

    const head = document.createElement('div');
    head.className = 'job-head';
    if (j.appId) {
      const icon = document.createElement('span');
      icon.className = 'jicon';
      icon.textContent = (j.gameName || '?').slice(0, 1);
      loadIconById('self', j.appId, icon);
      head.append(icon);
    }
    const label = document.createElement('span');
    label.className = 'jlabel';
    const gname = document.createElement('b');
    gname.textContent = j.gameName || j.label;
    label.append(gname);
    if (j.fromName && j.toName) {
      const route = document.createElement('span');
      route.className = 'jroute';
      route.textContent = `${j.fromName} → ${j.toName}`;
      label.append(route);
    }
    label.title = j.label;
    const st = document.createElement('span');
    st.className = 'jstate';
    st.textContent = j.paused ? '일시정지' : JOB_STATE_LABEL[j.state];
    head.append(label, st);
    const running = j.state !== 'done' && j.state !== 'failed' && j.state !== 'cancelled';
    // 항목별 제어: 대기·전송 중엔 일시정지/재개와 취소, 끝난 것은 제거
    const acts = document.createElement('span');
    acts.className = 'jacts';
    if (running) {
      if (j.paused) acts.append(iconBtn('play', '재개', () => void sft.resumeJob(j.id)));
      else if (j.state === 'queued' || j.state === 'planning' || j.state === 'transferring') {
        acts.append(iconBtn('pause', '일시정지', () => void sft.pauseJob(j.id)));
      }
      acts.append(iconBtn('close', '작업 취소', () => void sft.cancelJob(j.id), 'danger'));
    } else {
      acts.append(iconBtn('trash', '기록에서 제거', () => void sft.removeJob(j.id)));
    }
    head.append(acts);
    if (j.paused) row.classList.add('paused');
    row.append(head);

    // --- 2줄: 진행률과 현재 상태 -----------------------------------------
    const prog = document.createElement('div');
    prog.className = 'jprogress';
    const bar = document.createElement('div');
    bar.className = `bar ${j.state}`;
    const fill = document.createElement('div');
    fill.className = 'fill';
    const ratio = running
      ? (j.totalBytes > 0 ? j.doneBytes / j.totalBytes : (j.state === 'committing' || j.state === 'verifying' ? 1 : 0))
      : 1;
    fill.style.width = `${Math.round(Math.min(1, ratio) * 100)}%`;
    bar.append(fill);
    const msg = document.createElement('span');
    msg.className = 'jmsg';
    msg.textContent = j.message;
    msg.title = j.message;
    prog.append(bar, msg);
    if (j.totalBytes > 0) {
      const bytes = document.createElement('span');
      bytes.className = 'jbytes';
      bytes.textContent = running
        ? `${fmtBytes(j.doneBytes)} / ${fmtBytes(j.totalBytes)}`
        : fmtBytes(j.totalBytes);
      prog.append(bytes);
    }
    row.append(prog);

    // --- 3줄: 파일 분류별 개수 -------------------------------------------
    const t0 = j.targets[0];
    const failed = j.failedFiles + j.commitFailed;
    const mismatched = j.verify ? j.verify.differ + j.verify.missing : null;
    if (t0 || j.filesTotal > 0) {
      const detail = document.createElement('div');
      detail.className = 'jdetail';
      const cell = (k: string, v: number, tone?: 'ok' | 'bad'): HTMLSpanElement => {
        const s = document.createElement('span');
        if (tone) s.className = tone;
        const b = document.createElement('b');
        b.textContent = `${v}개`;
        s.append(`${k} `, b);
        return s;
      };
      if (t0?.error) {
        const e = document.createElement('span');
        e.className = 'bad';
        e.textContent = t0.error;
        detail.append(e);
      } else {
        if (t0) detail.append(cell('전체 파일', t0.skippedSame + t0.toSend.length));
        detail.append(cell('보낼 파일', t0 ? t0.toSend.length : j.filesTotal));
        detail.append(cell('보낸 파일', j.filesDone));
        // 문제를 세는 항목은 있을 때만 빨강으로 보여 준다.
        // 0개를 초록으로 칠하면 이름과 색이 반대로 읽힌다.
        if (failed > 0) detail.append(cell('실패한 파일', failed, 'bad'));
        if (mismatched !== null && mismatched > 0) detail.append(cell('검증에서 어긋난 파일', mismatched, 'bad'));
        if (j.unreadable.length > 0) detail.append(cell('읽지 못한 파일', j.unreadable.length, 'bad'));
        // 초록은 실제로 잘된 것에만 붙인다.
        if (!running && failed === 0 && j.unreadable.length === 0 && mismatched === 0) {
          const ok = document.createElement('span');
          ok.className = 'ok';
          ok.textContent = '검증 통과';
          detail.append(ok);
        }
      }
      row.append(detail);
    }
    list.append(row);
  }
}

function renderInbound(): void {
  const wrap = $('inboundWrap');
  const list = $('inboundList');
  if (state.inbound.length === 0) { wrap.hidden = true; return; }
  wrap.hidden = false;
  list.replaceChildren();
  for (const s of state.inbound) {
    const row = document.createElement('div');
    row.className = `inb ${s.state}`;
    const name = document.createElement('span');
    name.className = 'iname';
    const iname = document.createElement('b');
    iname.textContent = s.gameName;
    const iroute = document.createElement('span');
    iroute.className = 'jroute';
    iroute.textContent = `${s.from} → 이 기기`;
    name.append(iname, iroute);
    const meta = document.createElement('span');
    meta.className = 'imeta';
    meta.textContent = s.state === 'receiving' ? `받는 중 ${s.received} / ${s.needed}, ${fmtBytes(s.bytes)}`
      : s.state === 'committing' ? '교체 중'
      : s.state === 'done' ? `완료 ${s.message ?? ''}`.trim()
      : `실패 ${s.message ?? ''}`.trim();
    row.append(name, meta);
    list.append(row);
  }
}

let lastInboundJson = '';
async function pollInbound(): Promise<void> {
  try {
    const inbound = await sft.inbound();
    const json = JSON.stringify(inbound);
    if (json === lastInboundJson) return;
    lastInboundJson = json;
    state.inbound = inbound;
    renderInbound();
  } catch { /* 다음 주기에 다시 */ }
}

// --- 로그 / 상태 -------------------------------------------------------

function errText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  // Electron IPC 오류 접두사 제거
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

/** 평소에는 아무것도 보이지 않는다. 받을 수 없는 상태일 때만 전송 상태 패널에 한 줄 알린다. */
function renderStatus(st: AppState['status']): void {
  state.status = st;
  const problem = st.mode !== 'serving' && st.mode !== 'daemon-running';
  const el = $('statusWarn');
  el.hidden = !problem;
  el.textContent = problem ? `받을 수 없음: ${st.message}` : '';
}

// --- 자체 메시지 상자 (OS 대화상자 대신) -----------------------------------

function msgBox(title: string, text: string): Promise<void> {
  return new Promise((resolve) => {
    $('msgTitle').textContent = title;
    $('msgText').textContent = text;
    const buttons = $('msgButtons');
    buttons.replaceChildren();
    const ok = textBtn('확인', 'primary', () => { $('modalMsg').hidden = true; resolve(); });
    buttons.append(ok);
    $('modalMsg').hidden = false;
    ok.focus();
  });
}

// --- 초기화 ------------------------------------------------------------

function bind(): void {
  $('btnRefreshMine').onclick = () => void loadMine();
  $('mineSearch').append(searchBox('', '게임 이름으로 검색', (val) => { state.mineSearch = val; renderMine(); }));
  $('btnRefreshPeers').onclick = async () => {
    const s = await sft.getState();
    state.peers = s.peers;
    renderDevices();
    // 기기 목록을 열어 둔 상태라면 그 기기의 게임 목록도 다시 받는다.
    // 상대 기기에서 게임을 새로 설치했을 때 앱을 다시 켜지 않아도 되게 한다.
    const open = state.openDevice;
    if (open) {
      const p = allDevices().find((d) => !d.self && d.id === open);
      if (p) await loadDeviceGames(p);
    }
  };
  $('btnClearJobs').onclick = () => void sft.clearFinishedJobs();
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('modalMsg').hidden) ($('msgButtons').querySelector('button') as HTMLButtonElement | null)?.click();
  });
}

// --- 패널 크기 조절 ----------------------------------------------------
// 패널 사이 홈이 손잡이다. 평소엔 보이지 않고 잡고 있는 동안만 색이 든다.
// 비율(0~1)로 기억해서 창 크기가 바뀌어도 같은 비율을 유지한다.
type SplitAxis = 'x' | 'y';
const LAYOUT_KEY = 'sft.layout';
const SPLIT_DEFAULT: Record<SplitAxis, number> = { x: 0.5, y: 0.34 };
const SPLIT_RANGE: Record<SplitAxis, [number, number]> = { x: [0.2, 0.8], y: [0.15, 0.7] };

function clampSplit(axis: SplitAxis, v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : SPLIT_DEFAULT[axis];
  const [lo, hi] = SPLIT_RANGE[axis];
  return Math.min(hi, Math.max(lo, n));
}

function loadSplit(): Record<SplitAxis, number> {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<Record<SplitAxis, unknown>>) : {};
    return { x: clampSplit('x', v.x), y: clampSplit('y', v.y) };
  } catch {
    return { ...SPLIT_DEFAULT };
  }
}

function initSplitters(): void {
  const layout = document.querySelector<HTMLElement>('.layout');
  if (!layout) return;
  const split = loadSplit();
  const apply = (axis: SplitAxis): void => layout.style.setProperty(`--split-${axis}`, String(split[axis]));
  const save = (): void => {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(split)); } catch { /* 기억 못 해도 동작에는 지장 없음 */ }
  };
  apply('x');
  apply('y');

  const attach = (el: HTMLElement, axis: SplitAxis): void => {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* 합성 이벤트에는 포인터가 없다 */ }
      el.classList.add('active');
      document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y');

      const rect = layout.getBoundingClientRect();
      const cs = getComputedStyle(layout);
      const pad = {
        l: parseFloat(cs.paddingLeft), r: parseFloat(cs.paddingRight),
        t: parseFloat(cs.paddingTop), b: parseFloat(cs.paddingBottom),
      };
      const gutter = axis === 'x' ? el.offsetWidth : el.offsetHeight;

      const onMove = (ev: PointerEvent): void => {
        const frac = axis === 'x'
          ? (ev.clientX - rect.left - pad.l - gutter / 2) / (rect.width - pad.l - pad.r - gutter)
          : (rect.bottom - pad.b - ev.clientY - gutter / 2) / (rect.height - pad.t - pad.b - gutter);
        split[axis] = clampSplit(axis, frac);
        apply(axis);
      };
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        el.classList.remove('active');
        document.body.classList.remove('resizing-x', 'resizing-y');
        save();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
    // 더블클릭하면 기본 비율로
    el.addEventListener('dblclick', () => {
      split[axis] = SPLIT_DEFAULT[axis];
      apply(axis);
      save();
    });
  };
  const v = document.querySelector<HTMLElement>('.split-v');
  const h = document.querySelector<HTMLElement>('.split-h');
  if (v) attach(v, 'x');
  if (h) attach(h, 'y');
}

async function init(): Promise<void> {
  document.body.classList.add(`plat-${sft.platform}`);
  bind();
  initSplitters();
  sft.onPeers((peers) => { state.peers = peers; renderDevices(); });
  sft.onJobs((jobs) => { state.jobs = jobs; renderJobs(); });

  const s = await sft.getState();
  state.self = s.self;
  state.peers = s.peers;
  renderStatus(s.status);
  renderDevices();
  state.jobs = await sft.jobs();
  renderJobs();
  await loadMine();
  void pollInbound();

  // 주기적으로 기기 상태와 수신 현황 갱신. 기기 목록은 실제로 바뀐 게 있을 때만 다시 그린다.
  setInterval(async () => {
    const cur = await sft.getState();
    state.peers = cur.peers;
    state.self = cur.self;
    renderStatus(cur.status);
    if (deviceSignature() !== lastRenderedSignature) renderDevices();
  }, 4000);
  setInterval(() => void pollInbound(), jobsActive() ? 1000 : 1500);
}

void init();

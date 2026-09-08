// 대소문자 무시 경로 해석 등 파일시스템 유틸
import fs from 'node:fs';
import path from 'node:path';
import type { DirEntry, FileItem } from './types.ts';

/** 상대 경로를 정규화하고 상위 탈출(..)을 차단한다. 구분자는 슬래시로 통일 */
export function safeRelPath(rel: string): string {
  const parts = rel.replace(/\\/g, '/').split('/').filter((p) => p.length > 0 && p !== '.');
  if (parts.some((p) => p === '..')) throw new Error(`잘못된 경로: ${rel}`);
  return parts.join('/');
}

/**
 * 디렉터리 목록 캐시. 읽기 전용 비교를 대량으로 할 때 같은 폴더를 반복해서 읽지 않도록 한다.
 * 파일을 쓰는 경로에서는 목록이 바뀌므로 캐시를 쓰지 않는다.
 */
export type DirCache = Map<string, string[] | null>;
export function createDirCache(): DirCache { return new Map(); }

function readdirCached(dir: string, cache?: DirCache): string[] | null {
  const hit = cache?.get(dir);
  if (hit !== undefined) return hit;
  let entries: string[] | null;
  try { entries = fs.readdirSync(dir); } catch { entries = null; }
  cache?.set(dir, entries);
  return entries;
}

export interface ResolvedPath {
  /** 디스크에 실제로 기록된 철자를 반영한 절대 경로 */
  fullPath: string;
  exists: boolean;
}

/**
 * base 아래에서 rel 에 해당하는 실제 경로를 찾는다.
 *
 * 한글패치는 대개 Windows에서 만들어져 파일명 대소문자가 게임 원본과 다른 경우가 많다.
 * 리눅스(SteamOS)는 대소문자를 구분하므로 그대로 쓰면 덮어쓰기가 아니라 중복 파일이 생긴다.
 * 그래서 각 경로 조각을 실제 디렉터리 목록과 맞춰 보고, 철자만 다른 기존 항목이 있으면 그것을 쓴다.
 * 존재하지 않는 구간부터는 주어진 이름을 그대로 이어붙인다.
 */
export function resolveCaseInsensitive(base: string, rel: string, cache?: DirCache): ResolvedPath {
  const parts = safeRelPath(rel).split('/').filter(Boolean);
  if (parts.length === 0) return { fullPath: base, exists: fs.existsSync(base) };

  let cur = base;
  let chainExists = true;
  for (const part of parts) {
    if (chainExists) {
      const entries = readdirCached(cur, cache);
      if (entries) {
        if (entries.includes(part)) { cur = path.join(cur, part); continue; }
        const lower = part.toLowerCase();
        const hit = entries.find((e) => e.toLowerCase() === lower);
        if (hit) { cur = path.join(cur, hit); continue; }
      }
      chainExists = false;
    }
    cur = path.join(cur, part);
  }
  return { fullPath: cur, exists: chainExists };
}

export function listDir(dir: string): DirEntry[] {
  const out: DirEntry[] = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    try {
      const full = path.join(dir, d.name);
      const st = fs.statSync(full); // 심볼릭 링크는 대상 기준
      if (st.isDirectory()) out.push({ name: d.name, type: 'dir', size: 0 });
      else if (st.isFile()) out.push({ name: d.name, type: 'file', size: st.size });
    } catch { /* 접근 불가 항목 무시 */ }
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return out;
}

/** OS 가 만드는 메타 파일은 전송 대상에서 뺀다 */
export function isIgnoredFile(name: string): boolean {
  return name === '.DS_Store' || name === 'Thumbs.db' || name === 'desktop.ini';
}

/** 이 앱이 만드는 임시 폴더 이름. 전송 목록에 절대 들어가면 안 된다 */
export const STAGING_DIR_NAME = '.sft-staging';

export function isIgnoredDir(name: string): boolean {
  return name === STAGING_DIR_NAME;
}

export interface ExpandResult {
  files: FileItem[];
  /** 읽지 못해 목록에서 빠진 항목. 조용히 빠지면 사용자가 다 보냈다고 오해한다 */
  skipped: { relPath: string; reason: string }[];
}

/**
 * root 아래 selected 항목들(파일 또는 폴더, 상대 경로)을 재귀적으로 펼쳐 파일 목록을 만든다.
 *
 * 폴더 심볼릭 링크는 따라 들어가지 않는다. Proton prefix 안에는 상위를 가리키는 링크가 흔해서
 * 그대로 따라가면 같은 파일이 수십 번 잡히고 경로도 엉뚱해진다.
 */
export function expandSelection(root: string, selected: string[]): ExpandResult {
  const items: FileItem[] = [];
  const skipped: { relPath: string; reason: string }[] = [];
  const seen = new Set<string>();
  const visitedDirs = new Set<string>();

  const walk = (abs: string, rel: string): void => {
    let link: fs.Stats;
    try { link = fs.lstatSync(abs); } catch (e) {
      skipped.push({ relPath: rel, reason: (e as Error).message });
      return;
    }

    if (link.isSymbolicLink()) {
      let target: fs.Stats;
      try { target = fs.statSync(abs); } catch {
        skipped.push({ relPath: rel, reason: '끊어진 링크' });
        return;
      }
      if (target.isDirectory()) {
        skipped.push({ relPath: rel, reason: '폴더 링크는 따라가지 않습니다' });
        return;
      }
      if (!seen.has(rel)) { seen.add(rel); items.push({ relPath: rel, size: target.size }); }
      return;
    }

    if (link.isDirectory()) {
      if (isIgnoredDir(path.basename(abs))) return;
      // 하드링크나 마운트로 같은 폴더에 두 번 들어가는 것도 막는다
      let real: string;
      try { real = fs.realpathSync(abs); } catch { real = abs; }
      if (visitedDirs.has(real)) return;
      visitedDirs.add(real);
      let entries: string[];
      try { entries = fs.readdirSync(abs); } catch (e) {
        skipped.push({ relPath: rel, reason: (e as Error).message });
        return;
      }
      for (const d of entries) walk(path.join(abs, d), rel ? `${rel}/${d}` : d);
      return;
    }

    if (link.isFile()) {
      if (isIgnoredFile(path.basename(abs))) return;
      if (seen.has(rel)) return;
      seen.add(rel);
      items.push({ relPath: rel, size: link.size });
    }
  };

  const list = selected.length === 0 ? [''] : selected;
  for (const s of list) {
    const rel = safeRelPath(s);
    const abs = rel ? path.join(root, rel) : root;
    if (!fs.existsSync(abs)) continue;
    walk(abs, rel);
  }
  items.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { files: items, skipped };
}

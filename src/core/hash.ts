import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';

import path from 'node:path';
import { expandSelection } from './fsutil.ts';
import type { CheckItem } from './types.ts';

export interface HashedTree {
  files: CheckItem[];
  /** 읽지 못해 빠진 항목. 조용히 빼면 다 보냈다고 오해한다 */
  unreadable: { relPath: string; reason: string }[];
}

/** 폴더 전체를 훑어 파일마다 SHA-256 을 계산한다. 보내는 쪽과 받는 쪽이 같은 함수를 쓴다. */
export async function hashTree(root: string, onProgress?: (done: number, total: number, relPath: string) => void): Promise<HashedTree> {
  const { files: items, skipped } = expandSelection(root, []);
  const files: CheckItem[] = [];
  const unreadable = [...skipped];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    onProgress?.(i + 1, items.length, it.relPath);
    try {
      files.push({ relPath: it.relPath, size: it.size, sha256: await sha256File(path.join(root, it.relPath)) });
    } catch (e) {
      unreadable.push({ relPath: it.relPath, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { files, unreadable };
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(
    fs.createReadStream(filePath),
    new Writable({
      write(chunk, _enc, cb) { hash.update(chunk); cb(); },
    }),
  );
  return hash.digest('hex');
}

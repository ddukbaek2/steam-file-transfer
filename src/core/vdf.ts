// Valve KeyValues(VDF/ACF) 최소 파서. libraryfolders.vdf, appmanifest_*.acf 용도.
export type VdfValue = string | VdfObject;
export interface VdfObject { [key: string]: VdfValue }

export function parseVdf(text: string): VdfObject {
  let i = 0;
  const n = text.length;

  function skipWs(): void {
    while (i < n) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
      if (c === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++;
        continue;
      }
      break;
    }
  }

  function readToken(): string | null {
    skipWs();
    if (i >= n) return null;
    const c = text[i];
    if (c === '{' || c === '}') { i++; return c; }
    if (c === '"') {
      i++;
      let out = '';
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          const e = text[i + 1];
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          i += 2;
        } else {
          out += text[i++];
        }
      }
      i++; // closing quote
      return out;
    }
    // 따옴표 없는 토큰
    let out = '';
    while (i < n && !/[\s{}"]/.test(text[i])) out += text[i++];
    return out;
  }

  function readObject(): VdfObject {
    const obj: VdfObject = {};
    for (;;) {
      const key = readToken();
      if (key === null || key === '}') return obj;
      if (key === '{') continue; // 비정상 입력 관용 처리
      const val = readToken();
      if (val === null) return obj;
      if (val === '{') obj[key] = readObject();
      else obj[key] = val;
    }
  }

  return readObject();
}

/** 대소문자 구분 없이 키 조회 */
export function vdfGet(obj: VdfObject | undefined, key: string): VdfValue | undefined {
  if (!obj) return undefined;
  if (key in obj) return obj[key];
  const lk = key.toLowerCase();
  for (const k of Object.keys(obj)) if (k.toLowerCase() === lk) return obj[k];
  return undefined;
}

export function vdfString(obj: VdfObject | undefined, key: string): string | undefined {
  const v = vdfGet(obj, key);
  return typeof v === 'string' ? v : undefined;
}

export function vdfObject(obj: VdfObject | undefined, key: string): VdfObject | undefined {
  const v = vdfGet(obj, key);
  return typeof v === 'object' ? v : undefined;
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { configDir, ensureDir } from './paths.ts';
import { DEFAULT_DISCOVERY_PORT, DEFAULT_HTTP_PORT, type AppConfig, type OsKind } from './types.ts';

const FILE = 'config.json';

export function detectOs(): OsKind {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') {
    try {
      const rel = fs.readFileSync('/etc/os-release', 'utf8');
      if (/steamos/i.test(rel)) return 'steamos';
    } catch { /* ignore */ }
    return 'linux';
  }
  return 'unknown';
}

export function defaultConfig(): AppConfig {
  return {
    deviceId: randomUUID(),
    deviceName: os.hostname(),
    port: DEFAULT_HTTP_PORT,
    discoveryPort: DEFAULT_DISCOVERY_PORT,
    password: '',
    steamRoot: '',
    autoStart: true,
  };
}

export function loadConfig(): AppConfig {
  const file = path.join(configDir(), FILE);
  const base = defaultConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AppConfig>;
    const merged: AppConfig = { ...base, ...raw };
    // 누락 필드가 채워졌으면 저장해 둔다
    if (Object.keys(raw).length !== Object.keys(merged).length) saveConfig(merged);
    return merged;
  } catch {
    saveConfig(base);
    return base;
  }
}

export function saveConfig(cfg: AppConfig): void {
  ensureDir(configDir());
  fs.writeFileSync(path.join(configDir(), FILE), JSON.stringify(cfg, null, 2), 'utf8');
}

// 의존성 없이 앱 아이콘 PNG 를 생성한다 (zlib 로 직접 인코딩).
// Steam 계열 색감의 어두운 배경 + 양방향 화살표.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = 256;

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePng(file, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

const px = Buffer.alloc(SIZE * SIZE * 4);
const set = (x, y, r, g, b, a) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  // 알파 합성
  const sa = a / 255;
  px[i] = Math.round(px[i] * (1 - sa) + r * sa);
  px[i + 1] = Math.round(px[i + 1] * (1 - sa) + g * sa);
  px[i + 2] = Math.round(px[i + 2] * (1 - sa) + b * sa);
  px[i + 3] = Math.max(px[i + 3], a);
};

// 둥근 사각형 배경 (위에서 아래로 그러데이션)
const R = 48;
const inRounded = (x, y) => {
  const cx = Math.min(Math.max(x, R), SIZE - R);
  const cy = Math.min(Math.max(y, R), SIZE - R);
  return (x - cx) ** 2 + (y - cy) ** 2 <= R * R;
};
for (let y = 0; y < SIZE; y++) {
  const t = y / SIZE;
  const r = Math.round(0x2a + (0x17 - 0x2a) * t);
  const g = Math.round(0x3f + (0x1d - 0x3f) * t);
  const b = Math.round(0x5a + (0x25 - 0x5a) * t);
  for (let x = 0; x < SIZE; x++) {
    if (!inRounded(x, y)) continue;
    // 가장자리 안티에일리어싱
    let a = 255;
    const cx = Math.min(Math.max(x, R), SIZE - R);
    const cy = Math.min(Math.max(y, R), SIZE - R);
    const d = Math.hypot(x - cx, y - cy);
    if (d > R - 1.5) a = Math.round(255 * Math.max(0, R - d) / 1.5);
    set(x, y, r, g, b, a);
  }
}

// 양방향 화살표 (Steam 하늘색)
const AR = 0x66, AG = 0xc0, AB = 0xf4;
const bar = (x0, x1, y, thick) => {
  for (let x = x0; x <= x1; x++) {
    for (let y2 = y - thick / 2; y2 <= y + thick / 2; y2++) {
      set(Math.round(x), Math.round(y2), AR, AG, AB, 255);
    }
  }
};
const head = (tipX, y, dir, size, thick) => {
  for (let i = 0; i < size; i++) {
    for (let t = 0; t < thick; t++) {
      set(Math.round(tipX + dir * i), Math.round(y - i + t - thick / 2), AR, AG, AB, 255);
      set(Math.round(tipX + dir * i), Math.round(y + i - t + thick / 2), AR, AG, AB, 255);
    }
  }
};

// 위쪽 화살표: 오른쪽 방향
bar(72, 184, 104, 13);
head(184, 104, -1, 30, 13);
// 아래쪽 화살표: 왼쪽 방향
bar(72, 184, 152, 13);
head(72, 152, 1, 30, 13);

const outDir = path.join(projectRoot, 'deploy', 'steamdeck');
fs.mkdirSync(outDir, { recursive: true });
writePng(path.join(outDir, 'icon.png'), px);

const buildDir = path.join(projectRoot, 'build');
fs.mkdirSync(buildDir, { recursive: true });
writePng(path.join(buildDir, 'icon.png'), px);

console.log('아이콘 생성: deploy/steamdeck/icon.png, build/icon.png');

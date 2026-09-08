// esbuild 번들 스크립트: main(ESM) / preload(CJS) / renderer(브라우저) / daemon(CJS 단일 파일)
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/renderer', { recursive: true });

const common = {
  bundle: true,
  charset: 'utf8', // 한글 문자열을 이스케이프하지 않는다
  sourcemap: true,
  logLevel: 'info',
  target: ['node22'],
};

const builds = [
  // Electron 메인 프로세스 (ESM)
  esbuild.context({
    ...common,
    entryPoints: ['src/main/index.ts'],
    outfile: 'dist/main.js',
    platform: 'node',
    format: 'esm',
    external: ['electron'],
    banner: {
      // ESM 번들 안에서 CJS 의존성이 require를 쓰는 경우 대비
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  }),
  // preload (샌드박스 렌더러용 CJS)
  esbuild.context({
    ...common,
    entryPoints: ['src/main/preload.ts'],
    outfile: 'dist/preload.cjs',
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  }),
  // 렌더러 UI
  esbuild.context({
    ...common,
    entryPoints: ['src/renderer/app.ts'],
    outfile: 'dist/renderer/app.js',
    platform: 'browser',
    format: 'iife',
    target: ['chrome130'],
  }),
  // 헤드리스 데몬 (ELECTRON_RUN_AS_NODE 또는 순정 node로 실행)
  esbuild.context({
    ...common,
    entryPoints: ['src/daemon/index.ts'],
    outfile: 'dist/daemon.cjs',
    platform: 'node',
    format: 'cjs',
  }),
];

const contexts = await Promise.all(builds);
cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('src/renderer/styles.css', 'dist/renderer/styles.css');

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching...');
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}

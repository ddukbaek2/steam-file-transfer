// 테스트용 번들: TS 소스를 하나의 ESM 파일로 묶어 node:test 에서 import 한다.
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['tests/testable.ts'],
  outfile: 'dist-test/testable.mjs',
  bundle: true,
  charset: 'utf8', // 한글 문자열을 이스케이프하지 않는다
  platform: 'node',
  format: 'esm',
  target: ['node22'],
  sourcemap: true,
  logLevel: 'warning',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});

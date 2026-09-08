// 헤드리스 데몬 진입점. SteamOS 에서는 systemd 사용자 서비스로 실행된다.
// 실행 예: ELECTRON_RUN_AS_NODE=1 ./steam-file-transfer resources/app/dist/daemon.cjs
import { TransferNode } from '../core/node.ts';

async function main(): Promise<void> {
  const node = new TransferNode();
  node.on('log', (m: string) => console.log(m));
  const status = await node.start();
  console.log(`[daemon] ${node.selfInfo().name} (${node.selfInfo().os}) mode=${status.mode} addr=${status.addresses.join(',')}`);
  if (status.mode !== 'serving') {
    console.error('[daemon] 수신 서버를 열 수 없어 종료합니다.');
    process.exit(1);
  }
  const shutdown = async (): Promise<void> => {
    console.log('[daemon] 종료 중...');
    await node.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[daemon] 치명적 오류', e);
  process.exit(1);
});

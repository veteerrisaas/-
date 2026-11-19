import { fork, spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './config.js';
import { ServiceRestart } from './service-restart.js';

const entry = path.join(ROOT, 'src', 'watch-all.js');
const args = process.argv.length > 2 ? process.argv.slice(2) : [
  '--two-accounts', '--shared-history', '--sync-browser-modes', '--instance-account-failover',
  '--mobile-fallback', '--browser-mode', 'desktop', '--no-action-delays',
];

if (args.includes('--check')) {
  const result = spawnSync(process.execPath, [entry, ...args], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
  if (!process.exitCode) console.log('Retomada automática após encerramento: 15, 30, 60 e 120 minutos; depois repete 120. Sempre do início.');
} else {
  const service = new ServiceRestart({
    launch: () => fork(entry, args, { cwd: ROOT, execArgv: [],
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true }),
    killTree: (child) => {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else child.kill('SIGKILL');
    },
  });
  process.on('SIGINT', () => service.stop());
  process.on('SIGTERM', () => service.stop());
  service.start();
}

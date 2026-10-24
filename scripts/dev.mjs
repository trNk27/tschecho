// Runs the relay server (with reload) and the Vite dev server together.
import { spawn } from 'node:child_process';

const procs = [
  spawn('npx', ['tsx', 'watch', 'server/index.ts'], {
    stdio: 'inherit',
    env: { ...process.env, PORT: '8080' },
  }),
  spawn('npx', ['vite'], { stdio: 'inherit' }),
];

const stop = () => {
  for (const p of procs) p.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', stop);

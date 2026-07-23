import { spawn } from 'node:child_process';
import * as esbuild from 'esbuild';
import { options } from './build-scripts.mjs';

const ctx = await esbuild.context(options);
await ctx.watch();

const vite = spawn('npx', ['vite', 'build', '--watch'], { stdio: 'inherit' });
vite.on('exit', async (code) => {
  await ctx.dispose();
  process.exit(code ?? 0);
});

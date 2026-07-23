import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: { 'symbol-tool': 'src/tool/index.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  logLevel: 'info'
});

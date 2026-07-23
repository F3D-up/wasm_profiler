import * as esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';

const binaryenWithoutTla = {
  name: 'binaryen-without-tla',
  setup(build) {
    build.onLoad({ filter: /[\\/]binaryen[\\/]index\.js$/ }, async (args) => {
      const text = await readFile(args.path, 'utf8');
      const patched = text.replace(
        /var ([$\w]+)=await ([$\w]+)\(\),([$\w]+)=\1;/,
        'var $1=$2(),$3=$1;'
      );
      if (patched === text) {
        throw new Error('binaryen top-level-await pattern not found; check binaryen version');
      }
      return { contents: patched, loader: 'js' };
    });
  }
};

export const options = {
  entryPoints: {
    background: 'src/background/index.ts',
    content: 'src/content/index.ts',
    bridge: 'src/bridge/index.ts'
  },
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  outdir: 'dist',
  logLevel: 'info',
  external: ['module', 'node:module'],
  plugins: [binaryenWithoutTla]
};

if (import.meta.url === `file://${process.argv[1]}`) {
  await esbuild.build(options);
}

import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'renderer'), { recursive: true });

const common = { bundle: true, sourcemap: true, target: 'es2022', logLevel: 'info' };

await Promise.all([
  build({
    ...common,
    entryPoints: [join(root, 'src/main/main.ts'), join(root, 'src/main/preload.ts')],
    outdir: join(out, 'main'),
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: [join(root, 'src/renderer/app.ts')],
    outfile: join(out, 'renderer/app.js'),
    platform: 'browser',
    format: 'iife',
  }),
]);

await cp(join(root, 'src/renderer/index.html'), join(out, 'renderer/index.html'));
await cp(join(root, 'src/renderer/styles.css'), join(out, 'renderer/styles.css'));
await cp(join(root, 'build/icon.png'), join(out, 'renderer/icon.png'));

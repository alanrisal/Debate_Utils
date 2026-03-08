/**
 * scripts/copy-static.js
 * Copies static extension assets into dist/ after Vite builds the JS/HTML.
 * Run automatically via "npm run build".
 */
import { copyFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const DIST = join(ROOT, 'dist');

function copy(src, dest) {
  const destDir = dest.substring(0, dest.lastIndexOf('/') === -1 ? dest.lastIndexOf('\\') : dest.lastIndexOf('/'));
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, dest);
  console.log(`  copied  ${src.replace(ROOT, '').replace(/\\/g, '/')}  →  dist${dest.replace(DIST, '').replace(/\\/g, '/')}`);
}

function copyDir(srcDir, destDir) {
  if (!existsSync(srcDir)) return;
  mkdirSync(destDir, { recursive: true });
  for (const file of readdirSync(srcDir)) {
    const s = join(srcDir, file);
    const d = join(destDir, file);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else copy(s, d);
  }
}

// manifest.json
copy(join(ROOT, 'manifest.json'), join(DIST, 'manifest.json'));

// icons/ directory (PNG files for the extension toolbar icon)
copyDir(join(ROOT, 'icons'), join(DIST, 'icons'));

console.log('Static assets copied to dist/');

/**
 * Скрипт сборки статических файлов фронтенда в директорию dist/
 * для публикации на GitHub Pages, Cloudflare Workers Assets или Cloudflare Pages.
 * Обеспечивает корректную работу относительных путей (./styles.css, ./app.js, ./assets/*)
 * как в корне домена (/), так и в подпапках (/L-A-STUDIO/, /admin/).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

const STATIC_FILES = ['index.html', 'admin.html', 'styles.css', 'app.js', 'admin.js'];

function copyDirRecursive(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true, force: true });
}
fs.mkdirSync(distDir, { recursive: true });

for (const file of STATIC_FILES) {
  const src = path.join(rootDir, file);
  const dest = path.join(distDir, file);
  if (!fs.existsSync(src)) {
    throw new Error(`Missing required frontend file: ${file}`);
  }
  fs.copyFileSync(src, dest);
}

// Копируем директорию изображений assets/ в dist/assets/
const assetsSrcDir = path.join(rootDir, 'assets');
if (fs.existsSync(assetsSrcDir)) {
  copyDirRecursive(assetsSrcDir, path.join(distDir, 'assets'));
}

// Создаём dist/admin/ с копиями styles.css, admin.js и assets/,
// чтобы относительные ссылки ./styles.css и ./admin.js гарантированно открывались по адресу /admin и /admin/
const adminSubDir = path.join(distDir, 'admin');
fs.mkdirSync(adminSubDir, { recursive: true });
fs.copyFileSync(path.join(rootDir, 'admin.html'), path.join(adminSubDir, 'index.html'));
fs.copyFileSync(path.join(rootDir, 'styles.css'), path.join(adminSubDir, 'styles.css'));
fs.copyFileSync(path.join(rootDir, 'admin.js'), path.join(adminSubDir, 'admin.js'));
if (fs.existsSync(assetsSrcDir)) {
  copyDirRecursive(assetsSrcDir, path.join(adminSubDir, 'assets'));
}

// Создаём .nojekyll для корректной раздачи файлов на GitHub Pages
fs.writeFileSync(path.join(distDir, '.nojekyll'), '', 'utf8');

console.log('Static frontend build completed successfully -> dist/');

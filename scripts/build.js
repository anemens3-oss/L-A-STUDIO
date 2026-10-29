/**
 * Скрипт сборки статических файлов фронтенда в директорию dist/
 * для публикации на GitHub Pages или Cloudflare Pages без сторонних сборщиков.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

const STATIC_FILES = ['index.html', 'styles.css', 'app.js'];

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

// Создаём .nojekyll для корректной раздачи файлов на GitHub Pages
fs.writeFileSync(path.join(distDir, '.nojekyll'), '', 'utf8');

console.log('Static frontend build completed successfully -> dist/');

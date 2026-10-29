/**
 * LÉA STUDIO — Локальный и Production HTTP-сервер без сторонних фреймворков.
 * Использует только встроенные модули Node.js (node:http, node:fs, node:path, node:sqlite).
 * - Маршруты /api/* обрабатываются напрямую Cloudflare Worker модулем (worker/index.js)
 *   с подключённой постоянной SQLite/D1 базой данных (.data/lea-studio.sqlite).
 * - Статические файлы (index.html, styles.css, app.js) отдаются напрямую.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './worker/index.js';
import { createInitializedD1Database } from './worker/d1-sqlite-adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '.data', 'lea-studio.sqlite');

const db = createInitializedD1Database({
  dbPath: DB_FILE,
  migrationsDir: path.join(__dirname, 'migrations'),
});

const workerEnv = {
  DB: db,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  ADMIN_PASSWORD_SHA256: process.env.ADMIN_PASSWORD_SHA256 || '',
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > 1024 * 1024) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const hostHeader = req.headers.host || `localhost:${PORT}`;
    const fullUrl = new URL(req.url || '/', `http://${hostHeader}`);

    // Все запросы к /api/* делегируем в Cloudflare Worker (worker/index.js)
    if (fullUrl.pathname.startsWith('/api/')) {
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      let bodyBuffer;
      try {
        bodyBuffer = hasBody ? await readRequestBody(req) : undefined;
      } catch (bodyErr) {
        if (bodyErr && bodyErr.message === 'PAYLOAD_TOO_LARGE') {
          res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              ok: false,
              error: { code: 'PAYLOAD_TOO_LARGE', message: 'Размер запроса превышает допустимый лимит.' },
            })
          );
          return;
        }
        throw bodyErr;
      }

      const webRequest = new Request(fullUrl.toString(), {
        method: req.method,
        headers: req.headers,
        body: hasBody && bodyBuffer && bodyBuffer.length > 0 ? bodyBuffer : undefined,
      });

      const webResponse = await worker.fetch(webRequest, workerEnv, {
        waitUntil: (promise) => Promise.resolve(promise).catch(() => {}),
      });

      const responseHeaders = {};
      webResponse.headers.forEach((val, key) => {
        responseHeaders[key] = val;
      });

      res.writeHead(webResponse.status, responseHeaders);
      const arrayBuf = await webResponse.arrayBuffer();
      res.end(Buffer.from(arrayBuf));
      return;
    }

    // Отдача статических файлов фронтенда
    let safePath = path.normalize(decodeURIComponent(fullUrl.pathname)).replace(/^(\.\.(\/|\\|$))+/, '');
    if (safePath === '/' || safePath === '\\') {
      safePath = '/index.html';
    }

    const candidatePaths = [
      path.join(__dirname, safePath),
      path.join(__dirname, 'dist', safePath),
    ];

    let filePath = null;
    for (const candidate of candidatePaths) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        filePath = candidate;
        break;
      }
    }

    if (!filePath) {
      const indexCandidate = path.join(__dirname, 'index.html');
      if (fs.existsSync(indexCandidate) && !path.extname(safePath)) {
        filePath = indexCandidate;
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const content = fs.readFileSync(filePath);

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(content);
  } catch (err) {
    console.error('[Server Error]', err && err.message ? err.message : 'Unexpected error');
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: { code: 'SERVER_ERROR', message: 'Внутренняя ошибка сервера' } }));
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`LÉA STUDIO server running on http://${HOST}:${PORT}`);
});

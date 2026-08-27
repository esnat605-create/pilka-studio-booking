/* =============================================================================
   Локальный сервер для отладки без Netlify.
   -----------------------------------------------------------------------------
   Отдаёт папку public и проксирует /api/* в те же самые файлы функций, что
   уедут на Netlify. Смысл именно в этом: тестируется настоящий код функций, а
   не заглушка, поэтому найденное здесь поведение совпадёт с боевым.

   Запуск:  DATABASE_URL=postgresql://... node dev_server.js
   Затем откройте http://localhost:8877
   ========================================================================== */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8877;
const PUBLIC_DIR = path.join(__dirname, 'public');

const ROUTES = {
  '/api/catalog': './netlify/functions/catalog.js',
  '/api/slots': './netlify/functions/slots.js',
  '/api/book': './netlify/functions/book.js',
  '/api/cabinet': './netlify/functions/cabinet.js',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = ROUTES[url.pathname];

  // ---- API ------------------------------------------------------------------
  if (route) {
    // require без кэша, чтобы правки в функциях подхватывались без перезапуска
    delete require.cache[require.resolve(route)];
    const fn = require(route);

    const params = {};
    url.searchParams.forEach((v, k) => {
      params[k] = v;
    });

    const event = {
      httpMethod: req.method,
      headers: req.headers,
      queryStringParameters: params,
      body: req.method === 'POST' ? await readBody(req) : null,
      isBase64Encoded: false,
    };

    try {
      const result = await fn.handler(event);
      res.writeHead(result.statusCode, result.headers || {});
      res.end(result.body || '');
    } catch (err) {
      console.error('Ошибка функции:', err);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(err && err.message) }));
    }
    return;
  }

  // ---- Статика ---------------------------------------------------------------
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  if (rel === '/cabinet') rel = '/cabinet.html';
  // Простейшая защита от выхода за пределы public/
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Не найдено');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  console.log(`Локальный сервер запущен: http://localhost:${PORT}`);
});

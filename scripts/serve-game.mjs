import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.NZ_PORT) || 4173;

const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function safePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const relative = decoded === '/' ? 'NUKEM.html' : decoded.replace(/^\/+/, '');
  const resolved = path.resolve(ROOT, relative);
  return resolved === ROOT || resolved.startsWith(ROOT + path.sep) ? resolved : null;
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
  const filePath = safePath(requestUrl.pathname);
  if (!filePath) {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Bad path');
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    response.writeHead(200, {
      'content-type': TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    response.end(file);
  } catch (error) {
    const status = error?.code === 'ENOENT' ? 404 : 500;
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(status === 404 ? 'Not found' : 'Server error');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Nuke Zone 3D: http://127.0.0.1:${PORT}/NUKEM.html`);
  console.log('Press Ctrl+C to stop the server.');
});

function stop() {
  server.close(() => process.exit(0));
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

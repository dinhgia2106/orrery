// Local compile helper for the Orrery lab: the web page posts a sketch, this compiles it with the
// arduino-cli installed on this machine and returns the .hex. It only listens on 127.0.0.1.
//
//   npm run compiler            (needs: arduino-cli core install arduino:avr; arduino-cli lib install Servo)
//
// Only pages from the origins below may call it, so another website cannot use your machine to compile.
import { createServer } from 'node:http';
import { FQBN, cli, compile } from './arduino-cli.mjs';

const PORT = Number(process.env.ORRERY_COMPILER_PORT ?? 7337);
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'https://dinhgia2106.github.io',
  ...(process.env.ORRERY_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean),
]);
const MAX_BODY = 256 * 1024;

function send(res, status, body, origin) {
  const headers = { 'Content-Type': 'application/json', Vary: 'Origin' };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers['Access-Control-Allow-Private-Network'] = 'true'; // Chrome: public https page → localhost
  }
  res.writeHead(status, headers);
  res.end(body === null ? '' : JSON.stringify(body));
}

const server = createServer((req, res) => {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return send(res, 403, { ok: false, log: `origin ${origin} not allowed` });
  if (req.method === 'OPTIONS') return send(res, 204, null, origin);
  if (req.method === 'GET' && req.url === '/health') {
    return void cli(['version'], 10_000).then((r) => send(res, 200, { ok: r.ok, version: r.stdout.trim() || r.error, fqbn: FQBN }, origin));
  }
  if (req.method === 'POST' && req.url === '/compile') {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      let code;
      try {
        code = JSON.parse(Buffer.concat(chunks).toString('utf8')).code;
      } catch {
        return send(res, 400, { ok: false, log: 'expected JSON {"code": "..."}' }, origin);
      }
      if (typeof code !== 'string') return send(res, 400, { ok: false, log: 'missing "code"' }, origin);
      // compile() queues: one compile at a time
      compile(code).then((r) => send(res, 200, r, origin)).catch((e) => send(res, 500, { ok: false, log: String(e) }, origin));
    });
    return;
  }
  send(res, 404, { ok: false, log: 'not found' }, origin);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Orrery compile helper on http://127.0.0.1:${PORT} (board ${FQBN})`);
  console.log(`Allowed pages: ${[...ALLOWED_ORIGINS].join(', ')}`);
});

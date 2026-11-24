// Local compile helper for the Orrery lab: the web page posts a sketch, this compiles it with the
// arduino-cli installed on this machine and returns the .hex. It only listens on 127.0.0.1.
//
//   npm run compiler            (needs: arduino-cli core install arduino:avr; arduino-cli lib install Servo)
//
// Only pages from the origins below may call it, so another website cannot use your machine to compile.
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

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
const FQBN = 'arduino:avr:uno';
const CLI = process.env.ARDUINO_CLI ?? 'arduino-cli';

let busy = Promise.resolve();

function cli(args, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    execFile(CLI, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr), error: err && err.code === 'ENOENT' ? 'arduino-cli not found on PATH' : null }),
    );
  });
}

/** Refuse sketches that try to pull files from this machine into the build (#include of a path, .incbin). */
function unsafe(code) {
  const includes = [...code.matchAll(/#\s*include\s*[<"]([^>"]*)[>"]/g)].map((m) => m[1]);
  const bad = includes.find((p) => p.startsWith('/') || p.startsWith('\\') || p.includes('..') || /^[A-Za-z]:/.test(p));
  if (bad) return `#include "${bad}" is not allowed: use library headers, not file paths`;
  if (/\.incbin|\.include\b/.test(code)) return 'assembler .incbin / .include directives are not allowed';
  return null;
}

async function compile(code) {
  const reason = unsafe(code);
  if (reason) return { ok: false, log: reason };
  const root = mkdtempSync(join(tmpdir(), 'orrery-sketch-'));
  try {
    const dir = join(root, 'sketch');
    const out = join(root, 'out');
    mkdirSync(dir);
    mkdirSync(out);
    writeFileSync(join(dir, 'sketch.ino'), code);
    const r = await cli(['compile', '--fqbn', FQBN, '--output-dir', out, '--no-color', dir]);
    const clean = (s) => s.split(dir).join('').replace(/[\\/]sketch\.ino/g, 'sketch.ino').split(root).join('').split(homedir()).join('~');
    const log = clean(`${r.stdout}\n${r.stderr}`).trim();
    if (!r.ok) return { ok: false, log: r.error ?? log };
    return { ok: true, hex: readFileSync(join(out, 'sketch.ino.hex'), 'utf8'), log };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

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
      // one compile at a time
      busy = busy.then(async () => send(res, 200, await compile(code), origin)).catch((e) => send(res, 500, { ok: false, log: String(e) }, origin));
    });
    return;
  }
  send(res, 404, { ok: false, log: 'not found' }, origin);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Orrery compile helper on http://127.0.0.1:${PORT} (board ${FQBN})`);
  console.log(`Allowed pages: ${[...ALLOWED_ORIGINS].join(', ')}`);
});

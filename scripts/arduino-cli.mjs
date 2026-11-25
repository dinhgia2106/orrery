// arduino-cli on this machine, shared by the compile helper (compile-server.mjs) and the MCP server (src/mcp).
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const FQBN = 'arduino:avr:uno';
const CLI = process.env.ARDUINO_CLI ?? 'arduino-cli';

export function cli(args, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    execFile(CLI, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr), error: err && err.code === 'ENOENT' ? 'arduino-cli not found on PATH' : null }),
    );
  });
}

/** Refuse sketches that try to pull files from this machine into the build (#include of a path, .incbin). */
export function unsafe(code) {
  const includes = [...code.matchAll(/#\s*include\s*[<"]([^>"]*)[>"]/g)].map((m) => m[1]);
  const bad = includes.find((p) => p.startsWith('/') || p.startsWith('\\') || p.includes('..') || /^[A-Za-z]:/.test(p));
  if (bad) return `#include "${bad}" is not allowed: use library headers, not file paths`;
  if (/\.incbin|\.include\b/.test(code)) return 'assembler .incbin / .include directives are not allowed';
  return null;
}

let busy = Promise.resolve();

/** Compile one sketch for the Uno; one compile at a time. Paths in the log are stripped of this machine's folders. */
export function compile(code) {
  const run = busy.then(() => compileNow(code));
  busy = run.catch(() => undefined);
  return run;
}

async function compileNow(code) {
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

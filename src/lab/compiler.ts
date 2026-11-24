// Client for scripts/compile-server.mjs, the compile helper that runs on the user's own machine.
import { parseIntelHex } from '../sim/hex';

export const COMPILER_URL = 'http://127.0.0.1:7337';

export interface CompileResult {
  ok: boolean;
  program?: Uint16Array;
  log: string;
  /** Errors and warnings parsed from gcc output: line numbers in sketch.ino. */
  diagnostics: { line: number; col: number; level: 'error' | 'warning'; msg: string }[];
}

export async function compilerHealth(): Promise<string | null> {
  try {
    const res = await fetch(`${COMPILER_URL}/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { ok: boolean; version: string };
    return body.ok ? body.version : null;
  } catch {
    return null;
  }
}

export function parseDiagnostics(log: string): CompileResult['diagnostics'] {
  const out: CompileResult['diagnostics'] = [];
  for (const m of log.matchAll(/sketch\.ino:(\d+):(\d+):\s*(error|warning):\s*(.*)/g)) {
    out.push({ line: Number(m[1]), col: Number(m[2]), level: m[3] as 'error' | 'warning', msg: m[4] });
  }
  return out;
}

export async function compileSketch(code: string): Promise<CompileResult> {
  let body: { ok: boolean; hex?: string; log: string };
  try {
    const res = await fetch(`${COMPILER_URL}/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(180_000),
    });
    body = await res.json();
  } catch {
    return {
      ok: false,
      log: `No compile helper at ${COMPILER_URL}. Start it with "npm run compiler" (needs arduino-cli), or load a .hex built elsewhere.`,
      diagnostics: [],
    };
  }
  const diagnostics = parseDiagnostics(body.log ?? '');
  if (!body.ok || !body.hex) return { ok: false, log: body.log ?? 'compile failed', diagnostics };
  return { ok: true, program: parseIntelHex(body.hex), log: body.log, diagnostics };
}

export const FQBN: string;
export function cli(args: string[], timeoutMs?: number): Promise<{ ok: boolean; stdout: string; stderr: string; error: string | null }>;
export function unsafe(code: string): string | null;
export function compile(code: string): Promise<{ ok: true; hex: string; log: string } | { ok: false; log: string }>;

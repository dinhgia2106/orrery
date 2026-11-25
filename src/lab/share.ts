// Share links: a whole bench (project, and optionally the firmware each board runs) packed into the URL hash,
// so a link opens exactly that bench — on the public site, with no account, no server and no compiler.
// Format: "#z=" + base64url(deflate-raw(JSON SharePayload)). Older "#p=" links (base64url JSON of the project
// alone) still open. Runs in browsers and in Node ≥ 18 (CompressionStream), so tools can write links too.
import { parseProject, type Project } from './project';

/** The public Orrery site. */
export const PUBLIC_URL = 'https://dinhgia2106.github.io/orrery/';

/** Inflated links are refused past this size: a hash cannot make the page unpack gigabytes. */
const MAX_INFLATED_BYTES = 8 * 1024 * 1024;
/** Intel HEX text of a 32 KB ATmega328P flash is ~90 KB; anything much larger is not Uno firmware. */
const MAX_HEX_CHARS = 200_000;

export interface SharedBench {
  project: Project;
  /** Intel HEX per board id, for boards whose firmware travels with the link. */
  firmware: Record<string, string>;
}

interface SharePayload {
  format: 'orrery.share';
  version: 1;
  project: Project;
  firmware?: Record<string, string>;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_INFLATED_BYTES) {
      await reader.cancel();
      throw new Error('share link unpacks to more than 8 MB');
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
}

/** The hash ("#z=…") that opens this bench; `firmware` is Intel HEX per board id. */
export async function shareHash(project: Project, firmware: Record<string, string> = {}): Promise<string> {
  const payload: SharePayload = { format: 'orrery.share', version: 1, project };
  if (Object.keys(firmware).length) payload.firmware = firmware;
  return `#z=${toBase64Url(await deflate(new TextEncoder().encode(JSON.stringify(payload))))}`;
}

/** A full link to the bench on the public site (or another Orrery page given as `base`). */
export async function shareUrl(project: Project, firmware: Record<string, string> = {}, base = PUBLIC_URL): Promise<string> {
  return base.replace(/#.*$/, '') + (await shareHash(project, firmware));
}

export function isShareHash(hash: string): boolean {
  return /^#[zp]=[A-Za-z0-9_-]+$/.test(hash);
}

/** Open a share hash; null when it is not one or does not hold a valid bench. Firmware that is not Intel HEX is dropped. */
export async function readShareHash(hash: string): Promise<SharedBench | null> {
  const m = /^#([zp])=([A-Za-z0-9_-]+)$/.exec(hash);
  if (!m) return null;
  try {
    if (m[1] === 'p') return { project: parseProject(new TextDecoder().decode(fromBase64Url(m[2]))), firmware: {} };
    const raw = JSON.parse(new TextDecoder().decode(await inflate(fromBase64Url(m[2])))) as Partial<SharePayload>;
    if (raw.format !== 'orrery.share' || raw.version !== 1) return null;
    const project = parseProject(JSON.stringify(raw.project));
    const boards = new Set(project.devices.filter((d) => d.kind === 'uno').map((d) => d.id));
    const firmware: Record<string, string> = {};
    if (raw.firmware && typeof raw.firmware === 'object') {
      for (const [id, hex] of Object.entries(raw.firmware)) {
        if (boards.has(id) && typeof hex === 'string' && hex.length <= MAX_HEX_CHARS && hex.trimStart().startsWith(':')) firmware[id] = hex;
      }
    }
    return { project, firmware };
  } catch {
    return null;
  }
}

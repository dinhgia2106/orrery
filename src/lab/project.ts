// A lab project: the devices on the bench, the jumper wires between their pins, and the sketch.
// It is plain JSON so it can be saved to a file, kept in localStorage and shared as a link.
import { validateAssembly, type Assembly } from '../mech/assembly';
import { DEVICES, type DeviceKind, type DeviceProps } from './devices';

export interface Device {
  id: string;
  kind: DeviceKind;
  x: number;
  y: number;
  props: DeviceProps;
}

/** A jumper wire between two pins, written "deviceId.pin". */
export interface Wire {
  id: string;
  a: string;
  b: string;
  color: string;
}

export interface Project {
  version: 1;
  name: string;
  devices: Device[];
  wires: Wire[];
  /** Sketch of the board "uno" (the first board). */
  code: string;
  /** Sketches of further boards, by board id ("uno2", "uno3", …). */
  sketches?: Record<string, string>;
  /** The 3D mechanism (Orrery Assembly Format), if the bench has one. */
  assembly?: Assembly;
}

export const WIRE_COLORS = ['#e53935', '#1f1f1f', '#f28c1a', '#f5d142', '#33c46b', '#3d7bff', '#9b59b6', '#ffffff', '#8d6e63'];

/** A sensible default colour for a new wire: red for supplies, black for ground, otherwise cycle. */
export function defaultWireColor(a: string, b: string, index: number): string {
  const pins = [a, b].map((p) => p.split('.')[1]);
  if (pins.some((p) => p.startsWith('GND') || p === '-')) return '#1f1f1f';
  if (pins.some((p) => p === '5V' || p === '3V3' || p === 'VIN' || p === '+' || p === 'VMOT' || p === 'VDD' || p === 'V+')) return '#e53935';
  const signal = ['#f28c1a', '#f5d142', '#33c46b', '#3d7bff', '#9b59b6', '#8d6e63'];
  return signal[index % signal.length];
}

export function newDevice(kind: DeviceKind, existing: Device[], x: number, y: number): Device {
  if (kind === 'uno') {
    // the first board is "uno" (its sketch is project.code); further boards are uno2, uno3, …
    if (!existing.some((d) => d.id === 'uno')) return { id: 'uno', kind, x, y, props: {} };
    let k = 2;
    while (existing.some((d) => d.id === `uno${k}`)) k++;
    return { id: `uno${k}`, kind, x, y, props: {} };
  }
  const prefix = kind;
  let n = 1;
  while (existing.some((d) => d.id === `${prefix}${n}`)) n++;
  return { id: `${prefix}${n}`, kind, x, y, props: { ...DEVICES[kind].defaults } };
}

let wireSeq = 0;
export function newWireId(): string {
  wireSeq++;
  return `w${Date.now().toString(36)}${wireSeq}`;
}

export const EMPTY_CODE = `void setup() {
  // put your setup code here, to run once:
}

void loop() {
  // put your main code here, to run repeatedly:
}
`;

export function sketchOf(p: Project, boardId: string): string {
  return boardId === 'uno' ? p.code : p.sketches?.[boardId] ?? EMPTY_CODE;
}

export function withSketch(p: Project, boardId: string, code: string): Project {
  return boardId === 'uno' ? { ...p, code } : { ...p, sketches: { ...p.sketches, [boardId]: code } };
}

export function blankProject(): Project {
  return { version: 1, name: 'Untitled bench', devices: [], wires: [], code: EMPTY_CODE };
}

export function cloneProject(p: Project): Project {
  return JSON.parse(JSON.stringify(p)) as Project;
}

/** Parse untrusted JSON (a file or a link) into a Project, dropping anything malformed. */
export function parseProject(text: string): Project {
  const raw = JSON.parse(text) as Partial<Project>;
  if (raw.version !== 1 || !Array.isArray(raw.devices) || !Array.isArray(raw.wires) || typeof raw.code !== 'string') {
    throw new Error('not an Orrery project (version 1)');
  }
  const devices = raw.devices.filter(
    (d): d is Device => !!d && typeof d.id === 'string' && d.kind in DEVICES && Number.isFinite(d.x) && Number.isFinite(d.y),
  );
  const ids = new Set(devices.map((d) => d.id));
  const wires = raw.wires.filter(
    (x): x is Wire =>
      !!x && typeof x.a === 'string' && typeof x.b === 'string' && ids.has(x.a.split('.')[0]) && ids.has(x.b.split('.')[0]),
  );
  return {
    version: 1,
    name: typeof raw.name === 'string' ? raw.name.slice(0, 80) : 'Untitled bench',
    devices: devices.map((d) => ({ id: d.id, kind: d.kind, x: d.x, y: d.y, props: { ...(d.props ?? {}) } })),
    wires: wires.map((x) => ({ id: typeof x.id === 'string' ? x.id : newWireId(), a: x.a, b: x.b, color: typeof x.color === 'string' ? x.color : '#3d7bff' })),
    code: raw.code.slice(0, 200_000),
    sketches:
      raw.sketches && typeof raw.sketches === 'object'
        ? Object.fromEntries(Object.entries(raw.sketches).filter(([k, v]) => ids.has(k) && typeof v === 'string').map(([k, v]) => [k, (v as string).slice(0, 200_000)]))
        : undefined,
    assembly: raw.assembly === undefined ? undefined : validateAssembly(raw.assembly).assembly,
  };
}

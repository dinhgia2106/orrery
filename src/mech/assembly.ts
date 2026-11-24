// Orrery Assembly Format, version 1 — a mechanism described as JSON so people can import it and an AI can
// write it. Links (rigid parts) are connected by joints into a tree, like URDF, but in millimetres and
// degrees, and joints are driven by the devices on the Orrery bench (a servo, a stepper) or follow another
// joint (tendon-coupled fingers). The spec is in docs/assembly-format.md; the JSON Schema is served at
// public/schema/orrery-assembly-1.schema.json.
import type { DeviceKind } from '../lab/devices';

export type Vec3 = [number, number, number];

export type Shape =
  | { box: Vec3 }
  | { cylinder: { r: number; h: number } }
  | { capsule: { r: number; h: number } }
  | { sphere: number }
  | { mesh: { url?: string; data?: string; scale?: number } };

export interface Link {
  id: string;
  /** What it is, in a few words ("index finger, proximal phalanx"). */
  label?: string;
  shape: Shape;
  /** Pose of the shape in the link frame. */
  position?: Vec3;
  /** Euler XYZ, degrees. */
  rotation?: Vec3;
  material?: 'PLA' | 'PETG' | 'TPU' | 'ABS' | 'resin' | 'aluminium' | 'steel' | 'acrylic' | 'wood' | 'other';
  color?: string;
  opacity?: number;
  /** How it is obtained: printed, bought, cut or machined. */
  make?: 'print' | 'buy' | 'cut' | 'machine';
}

export type Drive =
  /** Joint value = linear map of the device's angle (servo 0–180°, stepper shaft degrees). */
  | { device: string; from?: [number, number]; to?: [number, number] }
  /** Joint value = ratio × value of another joint + offset (tendons, gears, linkages). */
  | { follow: string; ratio?: number; offset?: number };

export interface Joint {
  id: string;
  type: 'revolute' | 'prismatic' | 'fixed';
  parent: string;
  child: string;
  /** Child frame origin in the parent link frame. */
  position: Vec3;
  rotation?: Vec3;
  /** Motion axis in the child frame (unit vector after normalising). */
  axis?: Vec3;
  /** Degrees for revolute, millimetres for prismatic. Omit for a continuous joint. */
  limits?: [number, number];
  home?: number;
  drive?: Drive;
}

export interface Mount {
  /** Id of the device on the bench (created on import if it is missing). */
  device: string;
  kind: DeviceKind;
  link: string;
  position: Vec3;
  rotation?: Vec3;
}

export interface Hardware {
  item: string;
  qty: number;
  note?: string;
}

export interface Assembly {
  format: 'orrery.assembly';
  version: 1;
  name: string;
  description?: string;
  units: 'mm';
  /** Where the root link sits on the bench, in mm, relative to the Uno's centre. */
  placement?: Vec3;
  links: Link[];
  joints: Joint[];
  mounts?: Mount[];
  hardware?: Hardware[];
  notes?: string[];
}

export const ACTUATOR_KINDS: DeviceKind[] = ['servo', 'stepper'];
const MOUNTABLE: DeviceKind[] = ['servo', 'stepper', 'a4988', 'button', 'pot', 'led', 'resistor', 'cap'];
const MAX_LINKS = 400;
const MAX_SIZE_MM = 3000;
const MAX_MESH_BYTES = 4 * 1024 * 1024;
const ID = /^[A-Za-z][\w-]{0,47}$/;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  assembly?: Assembly;
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isVec = (x: unknown): x is Vec3 => Array.isArray(x) && x.length === 3 && x.every(isNum);

/** Check untrusted JSON (a file, a paste, an AI's answer) and explain every problem in plain words. */
export function validateAssembly(input: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const a = input as Partial<Assembly> | null;
  if (!a || typeof a !== 'object') return { ok: false, errors: ['not a JSON object'], warnings };
  if (a.format !== 'orrery.assembly') errors.push('"format" must be "orrery.assembly"');
  if (a.version !== 1) errors.push('"version" must be 1');
  if (a.units !== 'mm') errors.push('"units" must be "mm"');
  if (typeof a.name !== 'string' || !a.name.trim()) errors.push('"name" is required');
  if (a.placement !== undefined && !isVec(a.placement)) errors.push('"placement" must be [x, y, z] in mm');
  if (!Array.isArray(a.links) || a.links.length === 0) errors.push('"links" must be a non-empty array');
  if (!Array.isArray(a.joints)) errors.push('"joints" must be an array (it may be empty)');
  if (errors.length) return { ok: false, errors, warnings };

  const links = a.links!;
  const joints = a.joints!;
  if (links.length > MAX_LINKS) errors.push(`at most ${MAX_LINKS} links`);
  const linkIds = new Set<string>();
  links.forEach((l, i) => {
    const where = `links[${i}]${l && typeof l.id === 'string' ? ` "${l.id}"` : ''}`;
    if (!l || typeof l.id !== 'string' || !ID.test(l.id)) return errors.push(`${where}: "id" must start with a letter and use letters, digits, _ or -`);
    if (linkIds.has(l.id)) errors.push(`${where}: duplicate id`);
    linkIds.add(l.id);
    errors.push(...shapeErrors(l.shape).map((e) => `${where}: ${e}`));
    if (l.position !== undefined && !isVec(l.position)) errors.push(`${where}: "position" must be [x, y, z]`);
    if (l.rotation !== undefined && !isVec(l.rotation)) errors.push(`${where}: "rotation" must be [rx, ry, rz] in degrees`);
    if (l.opacity !== undefined && (!isNum(l.opacity) || l.opacity < 0 || l.opacity > 1)) errors.push(`${where}: "opacity" must be 0–1`);
    if (l.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(l.color))) errors.push(`${where}: "color" must be #rrggbb`);
  });

  const jointIds = new Set<string>();
  const parentOf = new Map<string, string>();
  joints.forEach((j, i) => {
    const where = `joints[${i}]${j && typeof j.id === 'string' ? ` "${j.id}"` : ''}`;
    if (!j || typeof j.id !== 'string' || !ID.test(j.id)) return errors.push(`${where}: "id" must start with a letter and use letters, digits, _ or -`);
    if (jointIds.has(j.id) || linkIds.has(j.id)) errors.push(`${where}: id already used`);
    jointIds.add(j.id);
    if (!['revolute', 'prismatic', 'fixed'].includes(j.type)) errors.push(`${where}: "type" must be revolute, prismatic or fixed`);
    if (!linkIds.has(j.parent)) errors.push(`${where}: parent link "${j.parent}" does not exist`);
    if (!linkIds.has(j.child)) errors.push(`${where}: child link "${j.child}" does not exist`);
    if (j.parent === j.child) errors.push(`${where}: a joint cannot connect a link to itself`);
    if (parentOf.has(j.child)) errors.push(`${where}: link "${j.child}" already has a parent joint (links form a tree)`);
    parentOf.set(j.child, j.parent);
    if (!isVec(j.position)) errors.push(`${where}: "position" must be [x, y, z] in the parent frame`);
    if (j.rotation !== undefined && !isVec(j.rotation)) errors.push(`${where}: "rotation" must be [rx, ry, rz] in degrees`);
    if (j.type !== 'fixed') {
      if (!isVec(j.axis) || Math.hypot(...j.axis) < 1e-9) errors.push(`${where}: a moving joint needs a non-zero "axis"`);
      if (j.limits !== undefined && (!Array.isArray(j.limits) || j.limits.length !== 2 || !j.limits.every(isNum) || j.limits[0] > j.limits[1]))
        errors.push(`${where}: "limits" must be [min, max] with min ≤ max`);
      if (j.home !== undefined && !isNum(j.home)) errors.push(`${where}: "home" must be a number`);
    } else if (j.drive) warnings.push(`${where}: a fixed joint ignores "drive"`);
  });

  const roots = [...linkIds].filter((id) => !parentOf.has(id));
  if (roots.length !== 1) errors.push(`exactly one root link is needed (a link no joint moves); found ${roots.length}: ${roots.join(', ') || 'none'}`);
  // cycles: walk up from every link
  for (const id of linkIds) {
    const seen = new Set<string>();
    let cur: string | undefined = id;
    while (cur && parentOf.has(cur)) {
      if (seen.has(cur)) {
        errors.push(`joints form a loop through "${cur}" (links must form a tree)`);
        break;
      }
      seen.add(cur);
      cur = parentOf.get(cur);
    }
  }

  const mounts = a.mounts ?? [];
  if (!Array.isArray(mounts)) errors.push('"mounts" must be an array');
  const mountDevices = new Map<string, DeviceKind>();
  (Array.isArray(mounts) ? mounts : []).forEach((m, i) => {
    const where = `mounts[${i}]`;
    if (!m || typeof m.device !== 'string' || !ID.test(m.device)) return errors.push(`${where}: "device" must be an id like "servo1"`);
    if (!MOUNTABLE.includes(m.kind)) errors.push(`${where}: "kind" must be one of ${MOUNTABLE.join(', ')}`);
    if (mountDevices.has(m.device)) errors.push(`${where}: device "${m.device}" is mounted twice`);
    mountDevices.set(m.device, m.kind);
    if (!linkIds.has(m.link)) errors.push(`${where}: link "${m.link}" does not exist`);
    if (!isVec(m.position)) errors.push(`${where}: "position" must be [x, y, z] in the link frame`);
    if (m.rotation !== undefined && !isVec(m.rotation)) errors.push(`${where}: "rotation" must be [rx, ry, rz] in degrees`);
  });

  // drives
  const byId = new Map(joints.map((j) => [j.id, j]));
  joints.forEach((j) => {
    const d = j?.drive;
    if (!d || j.type === 'fixed') return;
    const where = `joint "${j.id}" drive`;
    if ('device' in d) {
      const kind = mountDevices.get(d.device);
      if (!kind) errors.push(`${where}: device "${d.device}" is not in "mounts" — mount the actuator on a link`);
      else if (!ACTUATOR_KINDS.includes(kind)) errors.push(`${where}: a ${kind} cannot drive a joint (use servo or stepper)`);
      for (const k of ['from', 'to'] as const)
        if (d[k] !== undefined && (!Array.isArray(d[k]) || d[k]!.length !== 2 || !d[k]!.every(isNum))) errors.push(`${where}: "${k}" must be [a, b]`);
      if (d.from && d.from[0] === d.from[1]) errors.push(`${where}: "from" must span a range`);
    } else if ('follow' in d) {
      if (!byId.has(d.follow)) errors.push(`${where}: joint "${d.follow}" does not exist`);
      if (d.ratio !== undefined && !isNum(d.ratio)) errors.push(`${where}: "ratio" must be a number`);
      if (d.offset !== undefined && !isNum(d.offset)) errors.push(`${where}: "offset" must be a number`);
    } else errors.push(`${where}: needs "device" or "follow"`);
  });
  // follow loops
  for (const j of joints) {
    const seen = new Set<string>();
    let cur: Joint | undefined = j;
    while (cur?.drive && 'follow' in cur.drive) {
      if (seen.has(cur.id)) {
        errors.push(`joint "${j.id}" follows itself through a chain of "follow" drives`);
        break;
      }
      seen.add(cur.id);
      cur = byId.get(cur.drive.follow);
    }
  }

  const hardware = a.hardware ?? [];
  if (!Array.isArray(hardware) || hardware.some((h) => !h || typeof h.item !== 'string' || !isNum(h.qty) || h.qty <= 0))
    errors.push('"hardware" must be a list of { "item": string, "qty": number > 0 }');
  if (a.notes !== undefined && (!Array.isArray(a.notes) || a.notes.some((n) => typeof n !== 'string'))) errors.push('"notes" must be a list of strings');

  const undriven = joints.filter((j) => j && j.type !== 'fixed' && !j.drive).map((j) => j.id);
  if (undriven.length) warnings.push(`joints without a drive stay at "home": ${undriven.join(', ')}`);
  return { ok: errors.length === 0, errors, warnings, assembly: errors.length ? undefined : (a as Assembly) };
}

function shapeErrors(s: unknown): string[] {
  const size = (x: unknown) => isNum(x) && x > 0 && x <= MAX_SIZE_MM;
  if (!s || typeof s !== 'object') return ['"shape" is required'];
  const keys = Object.keys(s);
  if (keys.length !== 1) return ['"shape" must have exactly one of box, cylinder, capsule, sphere, mesh'];
  const sh = s as Record<string, unknown>;
  if ('box' in sh) return isVec(sh.box) && sh.box.every(size) ? [] : ['"box" must be [x, y, z] sizes in mm'];
  if ('sphere' in sh) return size(sh.sphere) ? [] : ['"sphere" must be a radius in mm'];
  if ('cylinder' in sh || 'capsule' in sh) {
    const c = (sh.cylinder ?? sh.capsule) as { r?: unknown; h?: unknown };
    return c && size(c.r) && size(c.h) ? [] : ['cylinder/capsule needs { "r": radius, "h": length } in mm (along the local Y axis)'];
  }
  if ('mesh' in sh) {
    const m = sh.mesh as { url?: unknown; data?: unknown; scale?: unknown };
    if (!m || (typeof m.url !== 'string' && typeof m.data !== 'string')) return ['"mesh" needs "url" or "data"'];
    if (typeof m.url === 'string' && !/^(https:\/\/|\.?\/?[\w./-]+\.stl$)/i.test(m.url)) return ['mesh "url" must be https:// or a relative .stl path'];
    if (typeof m.data === 'string' && (!m.data.startsWith('data:') || m.data.length > MAX_MESH_BYTES * 1.4)) return ['mesh "data" must be a data: URL under 4 MB'];
    if (m.scale !== undefined && !(isNum(m.scale) && m.scale > 0)) return ['mesh "scale" must be > 0'];
    return [];
  }
  return [`unknown shape "${keys[0]}"`];
}

/** Current value of every joint, given how to read a device's angle (degrees). */
export function jointValues(a: Assembly, deviceAngle: (device: string) => number | undefined): Map<string, number> {
  const byId = new Map(a.joints.map((j) => [j.id, j]));
  const out = new Map<string, number>();
  const clamp = (j: Joint, v: number) => (j.limits ? Math.min(j.limits[1], Math.max(j.limits[0], v)) : v);
  const value = (j: Joint, depth = 0): number => {
    if (out.has(j.id)) return out.get(j.id)!;
    let v = j.home ?? 0;
    const d = j.drive;
    if (j.type !== 'fixed' && d && depth < 64) {
      if ('device' in d) {
        const x = deviceAngle(d.device);
        if (x !== undefined) {
          const [f0, f1] = d.from ?? [0, 180];
          const [t0, t1] = d.to ?? d.from ?? [0, 180];
          v = t0 + ((x - f0) / (f1 - f0)) * (t1 - t0);
        }
      } else {
        const src = byId.get(d.follow);
        if (src) v = (d.ratio ?? 1) * value(src, depth + 1) + (d.offset ?? 0);
      }
    }
    v = j.type === 'fixed' ? 0 : clamp(j, v);
    out.set(j.id, v);
    return v;
  };
  for (const j of a.joints) value(j);
  return out;
}

/** Joints whose drive asks for more than their limits allow right now (they sit on a mechanical stop). */
export function jointsAtStop(a: Assembly, deviceAngle: (device: string) => number | undefined): string[] {
  const free: Assembly = { ...a, joints: a.joints.map((j) => ({ ...j, limits: undefined })) };
  const unclamped = jointValues(free, deviceAngle);
  return a.joints.filter((j) => j.limits && j.type !== 'fixed' && j.drive).filter((j) => {
    const v = unclamped.get(j.id)!;
    return v < j.limits![0] - 0.5 || v > j.limits![1] + 0.5;
  }).map((j) => j.id);
}

/** Rough bounding size of a shape in mm (for the BOM; meshes report 0 until loaded). */
export function shapeSize(s: Shape): Vec3 {
  if ('box' in s) return s.box;
  if ('sphere' in s) return [s.sphere * 2, s.sphere * 2, s.sphere * 2];
  if ('cylinder' in s) return [s.cylinder.r * 2, s.cylinder.h, s.cylinder.r * 2];
  if ('capsule' in s) return [s.capsule.r * 2, s.capsule.h + s.capsule.r * 2, s.capsule.r * 2];
  return [0, 0, 0];
}

/** An assembly holding one imported STL, so a user's own part can be dropped on the bench. */
export function assemblyFromStl(name: string, dataUrl: string): Assembly {
  return {
    format: 'orrery.assembly',
    version: 1,
    name,
    units: 'mm',
    links: [{ id: 'part', label: name, shape: { mesh: { data: dataUrl } }, material: 'PLA', make: 'print' }],
    joints: [],
  };
}

/** The instructions an AI needs to write a valid assembly for this bench. */
export function aiPrompt(request: string, schemaUrl: string, example: Assembly): string {
  return `You are designing a mechanism for Orrery, a browser lab that simulates Arduino firmware, circuits and 3D mechanisms.
Write ONE JSON document in the Orrery Assembly Format v1 (JSON Schema: ${schemaUrl}). Output only the JSON, no prose.

Rules:
- Units are millimetres and degrees. Y is up; the root link stands on the bench at y = 0.
- "links" are rigid parts. Each has one "shape": {"box":[x,y,z]} | {"cylinder":{"r","h"}} | {"capsule":{"r","h"}} | {"sphere":r}. Cylinders and capsules run along their local Y axis. "position"/"rotation" place the shape inside the link frame. Say how each link is made ("make": print/buy/cut/machine) and its "material".
- "joints" connect a parent link to a child link and form a tree with exactly one root. "position"/"rotation" give the child frame in the parent frame. Revolute joints turn about "axis" in degrees within "limits"; prismatic joints slide in mm.
- Drive a joint with a bench device: {"device":"servo1","from":[0,180],"to":[minDeg,maxDeg]} maps the servo angle to the joint. A stepper's shaft angle is in degrees. Coupled joints (tendons, gears, linkages) use {"follow":"otherJoint","ratio":r,"offset":o}.
- Every driving device must be listed in "mounts" with its kind (servo = TowerPro SG90, 23.1 × 12.2 × 29 mm; stepper = NEMA 17 SY42STH38-1684A, 42.3 × 42.3 × 38 mm; a4988 = Pololu 1182 driver board, 20.3 × 15.2 mm) and a pose on the link that holds it. Leave room for these real sizes.
- List fasteners, bearings, tendon line, springs and other non-electronic parts in "hardware" as {"item","qty","note"} without inventing part numbers.
- Put assumptions and assembly steps in "notes". Do not claim forces, torques or speeds you have not calculated.

A small valid example:
${JSON.stringify(example, null, 1)}

Design request: ${request}`;
}

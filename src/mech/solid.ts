// Watertight solids for printed parts: a link's shape with its holes, cuts, pockets and bosses, built with
// manifold (exact mesh booleans, always-manifold output), exported as binary STL in millimetres.
import Module, { type Manifold, type ManifoldToplevel } from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { SPEC } from '../sim/catalog';
import type { Feature, Link, PocketFor, Shape, Vec3 } from './assembly';

let loading: Promise<ManifoldToplevel> | null = null;

/** Loads the manifold WebAssembly module once. */
export function manifoldModule(): Promise<ManifoldToplevel> {
  loading ??= (async () => {
    const browser = typeof window !== 'undefined';
    const m = await Module(browser ? { locateFile: () => wasmUrl } : undefined);
    m.setup();
    return m;
  })();
  return loading;
}

/** ISO 273 medium-series clearance holes for metric screws. */
export const CLEARANCE_HOLE_MM = { M2: 2.4, M2_5: 2.9, M3: 3.4, M4: 4.5 } as const;
/** Default pocket clearance per side: a printing allowance, not a datasheet figure — tune it for your printer. */
export const DEFAULT_CLEARANCE_MM = 0.2;

/** Footprints of the standard pockets (mm), from catalog.ts. */
export function pocketFootprint(kind: PocketFor): { box?: [number, number]; holes?: { d: number; x: number; z: number }[]; label: string } {
  switch (kind) {
    case 'sg90':
      return { box: [SPEC.sg90.lengthMm, SPEC.sg90.widthMm], label: 'SG90 body 23.1 × 12.2' };
    case 'a4988':
      return { box: [SPEC.a4988.boardMm[0], SPEC.a4988.boardMm[1]], label: 'A4988 carrier 20.32 × 15.24' };
    case 'b3f':
      return { box: [SPEC.b3f.bodyMm, SPEC.b3f.bodyMm], label: 'B3F 6 × 6' };
    case 'nema17': {
      const s = SPEC.nema17.boltSpacingMm / 2;
      const d = CLEARANCE_HOLE_MM.M3;
      return {
        holes: [{ d: SPEC.nema17.pilotDiaMm, x: 0, z: 0 }, ...[[-s, -s], [s, -s], [-s, s], [s, s]].map(([x, z]) => ({ d, x, z }))],
        label: 'NEMA 17 face: φ22 pilot, 4 × φ3.4 on 31 mm',
      };
    }
  }
}

const segments = (r: number) => Math.min(256, Math.max(32, Math.ceil((2 * Math.PI * r) / 0.5)));

/** Euler XYZ in degrees, applied like three.js (matrix Rx·Ry·Rz). */
function posed(m: Manifold, position?: Vec3, rotation?: Vec3): Manifold {
  let out = m;
  if (rotation && rotation.some((a) => a !== 0)) out = out.rotate([0, 0, rotation[2]]).rotate([0, rotation[1], 0]).rotate([rotation[0], 0, 0]);
  if (position) out = out.translate(position);
  return out;
}

function primitive(M: ManifoldToplevel, s: Exclude<Shape, { mesh: unknown }>): Manifold {
  const { Manifold } = M;
  if ('box' in s) return Manifold.cube(s.box, true);
  if ('sphere' in s) return Manifold.sphere(s.sphere, segments(s.sphere));
  if ('cylinder' in s) return Manifold.cylinder(s.cylinder.h, s.cylinder.r, s.cylinder.r, segments(s.cylinder.r), true).rotate([-90, 0, 0]);
  const { r, h } = s.capsule;
  const body = Manifold.cylinder(h, r, r, segments(r), true).rotate([-90, 0, 0]);
  return Manifold.union([body, Manifold.sphere(r, segments(r)).translate([0, h / 2, 0]), Manifold.sphere(r, segments(r)).translate([0, -h / 2, 0])]);
}

/** A cylinder along the local x, y or z axis, centred on the origin. */
function rod(M: ManifoldToplevel, d: number, length: number, axis: 'x' | 'y' | 'z'): Manifold {
  const c = M.Manifold.cylinder(length, d / 2, d / 2, segments(d / 2), true);
  return axis === 'z' ? c : axis === 'y' ? c.rotate([-90, 0, 0]) : c.rotate([0, 90, 0]);
}

/** The link's printable solid in the link frame, or null for meshes (export those as they are). */
export function linkSolid(M: ManifoldToplevel, link: Link): Manifold | null {
  if ('mesh' in link.shape) return null;
  let solid = posed(primitive(M, link.shape), link.position, link.rotation);
  const box = solid.boundingBox();
  const through = 2 * Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) + 20;
  const adds: Manifold[] = [];
  const cuts: Manifold[] = [];
  for (const f of link.features ?? []) cuts.push(...featureSolids(M, f, through, adds));
  if (adds.length) solid = M.Manifold.union([solid, ...adds]);
  if (cuts.length) solid = solid.subtract(M.Manifold.union(cuts));
  return solid;
}

function featureSolids(M: ManifoldToplevel, f: Feature, through: number, adds: Manifold[]): Manifold[] {
  if ('hole' in f) return [rod(M, f.hole.d, f.hole.depth ?? through, f.hole.axis ?? 'y').translate(f.hole.position)];
  if ('cut' in f) return [posed(M.Manifold.cube(f.cut.box, true), f.cut.position, f.cut.rotation)];
  if ('add' in f) {
    adds.push(posed(primitive(M, f.add.shape), f.add.position, f.add.rotation));
    return [];
  }
  const c = f.pocket.clearance ?? DEFAULT_CLEARANCE_MM;
  const fp = pocketFootprint(f.pocket.for);
  const parts: Manifold[] = [];
  if (fp.box) parts.push(M.Manifold.cube([fp.box[0] + 2 * c, through, fp.box[1] + 2 * c], true));
  for (const h of fp.holes ?? []) parts.push(rod(M, h.d + 2 * c, through, 'y').translate([h.x, 0, h.z]));
  return parts.map((p) => posed(p, f.pocket.position, f.pocket.rotation));
}

export interface SolidMesh {
  /** xyz per vertex. */
  positions: Float32Array;
  /** Three vertex indices per triangle. */
  triangles: Uint32Array;
  volumeMm3: number;
  bbox: { min: Vec3; max: Vec3 };
  /** Number of disconnected solid shells (1 = one printable piece). */
  shells: number;
}

/** Copy a manifold out of WebAssembly memory and free it. */
export function toMesh(m: Manifold): SolidMesh {
  const mesh = m.getMesh();
  const n = mesh.vertProperties.length / mesh.numProp;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) positions[i * 3 + k] = mesh.vertProperties[i * mesh.numProp + k];
  const b = m.boundingBox();
  const parts = m.decompose();
  const shells = parts.length;
  for (const p of parts) p.delete();
  const out = { positions, triangles: Uint32Array.from(mesh.triVerts), volumeMm3: m.volume(), bbox: { min: [...b.min] as Vec3, max: [...b.max] as Vec3 }, shells };
  m.delete();
  return out;
}

/** Binary STL (little-endian), millimetres. */
export function toStl(mesh: SolidMesh, name: string): Uint8Array {
  const tris = mesh.triangles.length / 3;
  const buf = new ArrayBuffer(84 + tris * 50);
  const view = new DataView(buf);
  const header = new TextEncoder().encode(`Orrery ${name}`.slice(0, 79));
  new Uint8Array(buf, 0, 80).set(header);
  view.setUint32(80, tris, true);
  const P = mesh.positions;
  let o = 84;
  for (let t = 0; t < tris; t++) {
    const [a, b, c] = [mesh.triangles[t * 3], mesh.triangles[t * 3 + 1], mesh.triangles[t * 3 + 2]];
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    for (const v of [nx, ny, nz]) (view.setFloat32(o, v, true), (o += 4));
    for (const i of [a, b, c]) for (let k = 0; k < 3; k++) (view.setFloat32(o, P[i * 3 + k], true), (o += 4));
    view.setUint16(o, 0, true);
    o += 2;
  }
  return new Uint8Array(buf);
}

/** Edges where the surface folds by more than `angleDeg` (outlines and hole rims) — what a drawing shows. */
export function featureEdges(mesh: SolidMesh, angleDeg = 25): Float32Array {
  const P = mesh.positions;
  const T = mesh.triangles;
  const normals: number[][] = [];
  for (let t = 0; t < T.length / 3; t++) {
    const [a, b, c] = [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]];
    const u = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]];
    const v = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    normals.push([n[0] / l, n[1] / l, n[2] / l]);
  }
  const edges = new Map<string, number[]>();
  for (let t = 0; t < T.length / 3; t++)
    for (let e = 0; e < 3; e++) {
      const a = T[t * 3 + e];
      const b = T[t * 3 + ((e + 1) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(key, [...(edges.get(key) ?? []), t]);
    }
  const cos = Math.cos((angleDeg * Math.PI) / 180);
  const out: number[] = [];
  for (const [key, ts] of edges) {
    if (ts.length === 2) {
      const [n1, n2] = [normals[ts[0]], normals[ts[1]]];
      if (n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2] > cos) continue;
    }
    const [a, b] = key.split(',').map(Number);
    out.push(P[a * 3], P[a * 3 + 1], P[a * 3 + 2], P[b * 3], P[b * 3 + 1], P[b * 3 + 2]);
  }
  return Float32Array.from(out);
}

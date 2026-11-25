// 3D-print export: each printed part turned so it prints well, scaled, set on the bed with Z up (what slicers
// expect), checked for overhangs, given simple support columns where it needs them, and measured.
//
// The rules of thumb here are design choices, not datasheet values, and are all settings: an overhang needs
// support when its face leans more than 45° from vertical (the common FDM guideline); support columns are
// 1.2 mm square on a 2.5 mm grid with a 0.2 mm gap to the part so they snap off. A slicer's own supports are
// usually better — these show where support is needed and give a printable starting point.
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { Link, Vec3 } from './assembly';
import { DENSITY } from './physics';
import { linkSolid, manifoldModule, toMesh, toStl, type SolidMesh } from './solid';
import { zip } from './zip';

/** Which of the part's own axes points down onto the bed. */
export type Down = '-y' | '+y' | '-x' | '+x' | '-z' | '+z';
export const DOWNS: Down[] = ['-y', '+y', '-x', '+x', '-z', '+z'];

export interface PrintSettings {
  /** Uniform scale (1 = real size). */
  scale: number;
  /** Faces leaning more than this from vertical, facing down, need support (degrees). */
  overhangDeg: number;
  supports: boolean;
  /** Build volume X × Y × Z (mm) — set it to your printer's. */
  bed: Vec3;
  /** Orientation per part id; parts not listed are oriented automatically. */
  down: Record<string, Down>;
  /** Support column side, grid spacing and gap to the part (mm). */
  column: number;
  spacing: number;
  gap: number;
}

export const DEFAULT_PRINT: PrintSettings = { scale: 1, overhangDeg: 45, supports: true, bed: [200, 200, 200], down: {}, column: 1.2, spacing: 2.5, gap: 0.2 };

export interface PrintPlan {
  id: string;
  down: Down;
  /** Chosen automatically (true) or set by the user. */
  auto: boolean;
  /** On the bed, Z up, centred on X/Y, bottom at z = 0 (mm). */
  part: SolidMesh;
  supports: SolidMesh | null;
  size: Vec3;
  volumeMm3: number;
  supportVolumeMm3: number;
  /** Area of faces that need support, mm². */
  overhangMm2: number;
  /** Grams of filament for the part (solid; infill makes it less) and its supports, or null without a sourced density. */
  massG: number | null;
  supportMassG: number | null;
  fits: boolean;
  /** Holes and pockets scale with the part: at scale ≠ 1 they no longer fit real screws and servos. */
  scaledFeatures: boolean;
  /** Number of disconnected solid shells in the part (1 = one piece). */
  shells: number;
}

/** Rotation (degrees about X, Y) that brings the part's `down` axis to −Z. */
function turn(m: Manifold, down: Down): Manifold {
  switch (down) {
    case '-y':
      return m.rotate([90, 0, 0]); // +Y up, as modelled
    case '+y':
      return m.rotate([-90, 0, 0]);
    case '-z':
      return m;
    case '+z':
      return m.rotate([180, 0, 0]);
    case '-x':
      return m.rotate([0, -90, 0]);
    case '+x':
      return m.rotate([0, 90, 0]);
  }
}

/** The part on the bed: turned, scaled, centred on X/Y, resting on z = 0. */
function onBed(solid: Manifold, down: Down, scale: number): Manifold {
  const t = turn(solid, down).scale([scale, scale, scale]);
  const b = t.boundingBox();
  return t.translate([-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, -b.min[2]]);
}

/** Area of the faces that need support, and those faces (indices), for a mesh standing on z = 0. */
export function overhangs(mesh: SolidMesh, overhangDeg: number): { areaMm2: number; faces: number[] } {
  const P = mesh.positions;
  const T = mesh.triangles;
  const limit = -Math.sin((overhangDeg * Math.PI) / 180);
  const faces: number[] = [];
  let area = 0;
  for (let t = 0; t < T.length / 3; t++) {
    const a = T[t * 3] * 3;
    const b = T[t * 3 + 1] * 3;
    const c = T[t * 3 + 2] * 3;
    if (P[a + 2] < 0.01 && P[b + 2] < 0.01 && P[c + 2] < 0.01) continue; // on the bed
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len === 0) continue;
    if (nz / len < limit) {
      faces.push(t);
      area += len / 2;
    }
  }
  return { areaMm2: area, faces };
}

/**
 * Support columns: on a grid, wherever a vertical line first meets the part from below at an overhanging face,
 * a square column rises from the bed (or from the part surface under it) to that face, leaving `gap` at each
 * end that touches the part.
 */
function supportColumns(M: ManifoldToplevel, mesh: SolidMesh, faces: number[], s: PrintSettings): Manifold | null {
  if (!faces.length) return null;
  const P = mesh.positions;
  const T = mesh.triangles;
  const over = new Set(faces);
  const n = T.length / 3;
  // triangle footprints for a quick reject
  const box = new Float32Array(n * 4);
  for (let t = 0; t < n; t++) {
    const xs = [P[T[t * 3] * 3], P[T[t * 3 + 1] * 3], P[T[t * 3 + 2] * 3]];
    const ys = [P[T[t * 3] * 3 + 1], P[T[t * 3 + 1] * 3 + 1], P[T[t * 3 + 2] * 3 + 1]];
    box.set([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], t * 4);
  }
  // only grid points under an overhanging face matter
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const t of faces) {
    x0 = Math.min(x0, box[t * 4]);
    x1 = Math.max(x1, box[t * 4 + 1]);
    y0 = Math.min(y0, box[t * 4 + 2]);
    y1 = Math.max(y1, box[t * 4 + 3]);
  }
  const hits: { z: number; t: number }[] = [];
  const cols: Manifold[] = [];
  const g = s.spacing;
  // a grid slightly off round numbers, so lines do not run exactly along the edges of boxes and holes
  const off = 0.0137;
  for (let x = Math.ceil(x0 / g) * g + off; x <= x1; x += g)
    for (let y = Math.ceil(y0 / g) * g + off; y <= y1; y += g) {
      hits.length = 0;
      for (let t = 0; t < n; t++) {
        if (x < box[t * 4] || x > box[t * 4 + 1] || y < box[t * 4 + 2] || y > box[t * 4 + 3]) continue;
        const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
        // barycentric coordinates of (x, y) in the triangle's footprint
        const d = (P[b + 1] - P[c + 1]) * (P[a] - P[c]) + (P[c] - P[b]) * (P[a + 1] - P[c + 1]);
        if (Math.abs(d) < 1e-12) continue;
        const l1 = ((P[b + 1] - P[c + 1]) * (x - P[c]) + (P[c] - P[b]) * (y - P[c + 1])) / d;
        const l2 = ((P[c + 1] - P[a + 1]) * (x - P[c]) + (P[a] - P[c]) * (y - P[c + 1])) / d;
        const l3 = 1 - l1 - l2;
        if (l1 < 0 || l2 < 0 || l3 < 0) continue;
        hits.push({ z: l1 * P[a + 2] + l2 * P[b + 2] + l3 * P[c + 2], t });
      }
      hits.sort((p, q) => p.z - q.z);
      // a line through a shared edge meets both triangles: count that crossing once
      for (let i = hits.length - 1; i > 0; i--) if (hits[i].z - hits[i - 1].z < 1e-6) hits.splice(i, 1);
      // walk up the line: every overhanging face met from open air below gets a column down to what is under it
      let floor = 0;
      let inside = false;
      for (const h of hits) {
        if (!inside && over.has(h.t)) {
          const bottom = floor === 0 ? 0 : floor + s.gap;
          const top = h.z - s.gap;
          if (top - bottom > 0.4) cols.push(M.Manifold.cube([s.column, s.column, top - bottom], false).translate([x - s.column / 2, y - s.column / 2, bottom]));
        }
        inside = !inside;
        if (!inside) floor = h.z;
      }
    }
  return cols.length ? M.Manifold.union(cols) : null;
}

/** Plan one printed part; null for parts without a solid (imported meshes). */
export async function planPart(link: Link, settings: PrintSettings = DEFAULT_PRINT): Promise<PrintPlan | null> {
  const M = await manifoldModule();
  const solid = linkSolid(M, link);
  if (!solid) return null;
  const fixed = settings.down[link.id];
  const candidates = fixed ? [fixed] : DOWNS;
  let best: { down: Down; part: Manifold; supports: Manifold | null; over: number; score: number } | null = null;
  for (const down of candidates) {
    const part = onBed(solid, down, settings.scale);
    const mesh = toMesh(part.translate([0, 0, 0])); // toMesh frees its argument, keep `part`
    const o = overhangs(mesh, settings.overhangDeg);
    const sup = settings.supports ? supportColumns(M, mesh, o.faces, settings) : null;
    const b = part.boundingBox();
    const height = b.max[2] - b.min[2];
    const fits = b.max[0] - b.min[0] <= settings.bed[0] && b.max[1] - b.min[1] <= settings.bed[1] && height <= settings.bed[2];
    // least support (or overhang when supports are off), then lower; a part that does not fit comes last
    const score = (sup ? sup.volume() : 0) + o.areaMm2 * 0.05 + height * 0.01 + (fits ? 0 : 1e9);
    if (!best || score < best.score) {
      best?.part.delete();
      best?.supports?.delete();
      best = { down, part, supports: sup, over: o.areaMm2, score };
    } else {
      part.delete();
      sup?.delete();
    }
  }
  solid.delete();
  const b = best!.part.boundingBox();
  const size: Vec3 = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]].map((v) => Math.round(v * 100) / 100) as Vec3;
  const supports = best!.supports ? toMesh(best!.supports) : null;
  const part = toMesh(best!.part);
  const rho = DENSITY[link.material ?? 'PLA']?.gPerCm3;
  return {
    id: link.id,
    down: best!.down,
    auto: !fixed,
    part,
    supports,
    size,
    volumeMm3: part.volumeMm3,
    supportVolumeMm3: supports?.volumeMm3 ?? 0,
    overhangMm2: best!.over,
    massG: rho ? (part.volumeMm3 / 1000) * rho : null,
    supportMassG: rho && supports ? (supports.volumeMm3 / 1000) * rho : null,
    fits: size[0] <= settings.bed[0] && size[1] <= settings.bed[1] && size[2] <= settings.bed[2],
    scaledFeatures: settings.scale !== 1 && !!link.features?.some((f) => 'hole' in f || 'pocket' in f),
    shells: part.shells,
  };
}

/** Part and supports in one STL (slicers load them as one object; split by parts to separate them). */
export function planStl(plan: PrintPlan, withSupports = true): Uint8Array {
  if (!withSupports || !plan.supports) return toStl(plan.part, plan.id);
  const a = plan.part;
  const b = plan.supports;
  const offset = a.positions.length / 3;
  const merged: SolidMesh = {
    positions: Float32Array.from([...a.positions, ...b.positions]),
    triangles: Uint32Array.from([...a.triangles, ...Array.from(b.triangles, (i) => i + offset)]),
    volumeMm3: a.volumeMm3 + b.volumeMm3,
    bbox: a.bbox,
    shells: a.shells + b.shells,
  };
  return toStl(merged, `${plan.id} with supports`);
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** Every printed part, ready for a slicer: STLs (Z up, on the bed), supports separately, a sheet of sizes. */
export async function printPackage(name: string, links: Link[], settings: PrintSettings): Promise<{ zip: Uint8Array; plans: PrintPlan[] }> {
  const plans: PrintPlan[] = [];
  for (const l of links) {
    const p = await planPart(l, settings);
    if (p) plans.push(p);
  }
  const files: { name: string; data: Uint8Array | string }[] = [];
  for (const p of plans) {
    files.push({ name: `print/${p.id}.stl`, data: toStl(p.part, p.id) });
    if (p.supports) files.push({ name: `print/${p.id}-supports.stl`, data: toStl(p.supports, `${p.id} supports`) });
  }
  const q = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [['Part', 'Down on bed', 'X mm', 'Y mm', 'Z mm', 'Volume cm3', 'Solid mass g', 'Overhang mm2', 'Supports cm3', 'Fits bed', 'Files'].map(q).join(',')].concat(
    plans.map((p) =>
      [p.id, p.down, r1(p.size[0]), r1(p.size[1]), r1(p.size[2]), (p.volumeMm3 / 1000).toFixed(2), p.massG === null ? '' : r1(p.massG), Math.round(p.overhangMm2), (p.supportVolumeMm3 / 1000).toFixed(2), p.fits ? 'yes' : 'NO', `print/${p.id}.stl${p.supports ? ` + print/${p.id}-supports.stl` : ''}`]
        .map(q)
        .join(','),
    ),
  );
  files.push({ name: 'print.csv', data: rows.join('\r\n') + '\r\n' });
  const scaled = plans.filter((p) => p.scaledFeatures).map((p) => p.id);
  const detached = plans.filter((p) => p.shells > 1);
  files.push({
    name: 'README.txt',
    data: [
      `${name} — 3D print files from Orrery`,
      '',
      `Scale ${settings.scale} (${settings.scale === 1 ? 'real size' : `${Math.round(settings.scale * 100)} %`}). Units mm, Z up, every part centred on X/Y and resting on z = 0.`,
      `Build volume checked: ${settings.bed.join(' x ')} mm.${plans.some((p) => !p.fits) ? ` Too big: ${plans.filter((p) => !p.fits).map((p) => p.id).join(', ')}.` : ''}`,
      '',
      `Supports: faces leaning more than ${settings.overhangDeg} deg from vertical, facing down, are supported by ${settings.column} mm square columns on a ${settings.spacing} mm grid with a ${settings.gap} mm gap to the part (rules of thumb, not printer data).`,
      'Load <part>-supports.stl together with <part>.stl, or ignore it and let your slicer generate supports.',
      'Masses are for solid parts; infill makes them lighter.',
      ...(scaled.length ? ['', `Scaled holes and pockets no longer fit real screws and servos: ${scaled.join(', ')}.`] : []),
      ...(detached.length ? ['', `Detached pieces (more than one solid shell — fix before printing): ${detached.map((p) => `${p.id} (${p.shells})`).join(', ')}.`] : []),
    ].join('\r\n'),
  });
  return { zip: zip(files), plans };
}

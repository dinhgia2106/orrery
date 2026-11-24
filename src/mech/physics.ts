// Physics of a mechanism: real masses and centres of mass (integrated from the printable solids), gravity
// torques at every joint in the current pose, the load each servo or stepper feels through its transmission
// (virtual work), and interference between parts. Everything here is a statics model: no inertia,
// friction or compliance — see README "What the physics covers".
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { DeviceKind } from '../lab/devices';
import { SPEC } from '../sim/catalog';
import type { Assembly, Joint, Link, Vec3 } from './assembly';
import { linkSolid, manifoldModule } from './solid';

export interface Density {
  gPerCm3: number;
  source: string;
}

/** Densities from the material makers' data sheets (ISO 1183 where stated). Other materials need a massG. */
export const DENSITY: Partial<Record<NonNullable<Link['material']>, Density>> = {
  PLA: { gPerCm3: 1.24, source: 'Prusament PLA TDS v1.1 (ISO 1183); other PLAs range 1.17–1.31' },
  PETG: { gPerCm3: 1.27, source: 'Prusament PETG TDS (ISO 1183)' },
  ABS: { gPerCm3: 1.04, source: 'Essentium ABS MG94 TDS (ISO 1183)' },
  aluminium: { gPerCm3: 2.7, source: 'ASM / MatWeb and Aalco data sheets for 6061-T6' },
};

/** Bought parts mounted on links: mass and centre of mass in the mount frame (mm). */
export const MOUNT_MASS: Partial<Record<DeviceKind, { g: number; com: Vec3; source: string }>> = {
  // approx centre: the middle of the SG90 case (model origin is the output shaft at the case bottom)
  servo: { g: SPEC.sg90.weightG, com: [SPEC.sg90.lengthMm / 2 - 5.9, SPEC.sg90.heightMm / 2, 0], source: 'TowerPro SG90: 9 g' },
  // middle of the body, which runs from the front face (origin) towards −Z
  stepper: { g: SPEC.nema17.weightG, com: [0, 0, -SPEC.nema17.bodyMm / 2], source: 'Pololu #2267: 285 g' },
  a4988: { g: 1.3, com: [0, 6, 0], source: 'Pololu #1182 specs: 1.3 g' },
};

export interface MassProps {
  massG: number;
  /** Centre of mass in the link frame, mm. */
  com: Vec3;
  how: 'solid' | 'given' | 'unknown';
  note?: string;
}

/** Mass and centre of mass of every link: solid volume × density, or the link's own massG. Solid = 100 % infill (an upper bound for prints). */
export async function massProperties(asm: Assembly): Promise<Map<string, MassProps>> {
  const M = await manifoldModule();
  const out = new Map<string, MassProps>();
  for (const l of asm.links) {
    const center = (l.position ?? [0, 0, 0]) as Vec3;
    const given = l.massG;
    if (given !== undefined) {
      out.set(l.id, { massG: given, com: center, how: 'given' });
      continue;
    }
    const rho = DENSITY[l.material ?? 'PLA'];
    const solid = rho ? linkSolid(M, l) : null;
    if (!rho || !solid) {
      out.set(l.id, { massG: 0, com: center, how: 'unknown', note: !rho ? `no sourced density for ${l.material}: set massG` : 'mesh part: set massG' });
      continue;
    }
    const mesh = solid.getMesh();
    const P = mesh.vertProperties;
    const k = mesh.numProp;
    const T = mesh.triVerts;
    let vol = 0;
    const c = [0, 0, 0];
    for (let t = 0; t < T.length; t += 3) {
      const a = T[t] * k;
      const b = T[t + 1] * k;
      const d = T[t + 2] * k;
      // signed volume of the tetrahedron (origin, a, b, d)
      const v =
        (P[a] * (P[b + 1] * P[d + 2] - P[b + 2] * P[d + 1]) - P[a + 1] * (P[b] * P[d + 2] - P[b + 2] * P[d]) + P[a + 2] * (P[b] * P[d + 1] - P[b + 1] * P[d])) / 6;
      vol += v;
      for (let i = 0; i < 3; i++) c[i] += (v * (P[a + i] + P[b + i] + P[d + i])) / 4;
    }
    solid.delete();
    out.set(l.id, { massG: (vol / 1000) * rho.gPerCm3, com: [c[0] / vol, c[1] / vol, c[2] / vol], how: 'solid' });
  }
  return out;
}

const DEG = Math.PI / 180;
const local = (pos?: Vec3, rot?: Vec3) =>
  new Matrix4().compose(new Vector3(...(pos ?? [0, 0, 0])), new Quaternion().setFromEuler(new Euler(...(rot ?? [0, 0, 0]).map((a) => a * DEG) as [number, number, number])), new Vector3(1, 1, 1));

/** World matrix of every link frame (mm) for the given joint values. */
export function linkFrames(asm: Assembly, values: Map<string, number>): Map<string, Matrix4> {
  const byChild = new Map(asm.joints.map((j) => [j.child, j]));
  const out = new Map<string, Matrix4>();
  const frame = (id: string, depth = 0): Matrix4 => {
    const hit = out.get(id);
    if (hit) return hit;
    const j = byChild.get(id);
    let m: Matrix4;
    if (!j || depth > 400) m = local(asm.placement ?? [150, 0, 0]);
    else m = frame(j.parent, depth + 1).clone().multiply(jointFrame(j)).multiply(jointMotion(j, values.get(j.id) ?? 0));
    out.set(id, m);
    return m;
  };
  for (const l of asm.links) frame(l.id);
  return out;
}

function jointFrame(j: Joint): Matrix4 {
  return local(j.position, j.rotation);
}

function jointMotion(j: Joint, v: number): Matrix4 {
  const axis = new Vector3(...(j.axis ?? [0, 0, 1])).normalize();
  if (j.type === 'revolute') return new Matrix4().makeRotationAxis(axis, v * DEG);
  if (j.type === 'prismatic') return new Matrix4().makeTranslation(axis.x * v, axis.y * v, axis.z * v);
  return new Matrix4();
}

export interface ActuatorLoad {
  device: string;
  kind: 'servo' | 'stepper';
  /** Gravity torque at the actuator shaft, kgf·cm; positive pushes towards increasing device angle. */
  torqueKgfCm: number;
  /** Stall torque (servo) or holding torque (stepper), kgf·cm. */
  limitKgfCm: number;
  joints: string[];
}

export interface Loads {
  /** Gravity torque about each revolute joint, gf·mm, positive towards increasing joint angle. */
  joints: Map<string, number>;
  actuators: Map<string, ActuatorLoad>;
  totalMassG: number;
}

/**
 * Gravity loads in the current pose. Each body (link or mounted part) weighs m gf straight down; the torque
 * about a revolute joint is Σ (r × F)·axis over everything it carries. A follower joint (tendon, gear) passes
 * its torque to the joint it follows × ratio, and a driven joint passes it to its device × (joint degrees per
 * device degree) — ideal, friction-free transmissions (virtual work).
 */
export function gravityLoads(asm: Assembly, props: Map<string, MassProps>, values: Map<string, number>): Loads {
  const frames = linkFrames(asm, values);
  const bodies: { link: string; m: number; p: Vector3 }[] = [];
  for (const l of asm.links) {
    const mp = props.get(l.id);
    if (mp && mp.massG > 0) bodies.push({ link: l.id, m: mp.massG, p: new Vector3(...mp.com).applyMatrix4(frames.get(l.id)!) });
  }
  for (const mt of asm.mounts ?? []) {
    const mm = MOUNT_MASS[mt.kind];
    if (!mm) continue;
    const f = frames.get(mt.link)!.clone().multiply(local(mt.position, mt.rotation));
    bodies.push({ link: mt.link, m: mm.g, p: new Vector3(...mm.com).applyMatrix4(f) });
  }
  const carriedBy = subtrees(asm);
  const gravity = new Vector3(0, -1, 0); // 1 gf per gram
  const joints = new Map<string, number>();
  for (const j of asm.joints) {
    if (j.type !== 'revolute') continue;
    const base = frames.get(j.parent)!.clone().multiply(jointFrame(j));
    const origin = new Vector3().setFromMatrixPosition(base);
    const axis = new Vector3(...(j.axis ?? [0, 0, 1])).normalize().transformDirection(base);
    const carried = carriedBy.get(j.child)!;
    let tau = 0;
    for (const b of bodies) if (carried.has(b.link)) tau += b.p.clone().sub(origin).cross(gravity.clone().multiplyScalar(b.m)).dot(axis);
    joints.set(j.id, tau);
  }
  // pass follower torques back to their sources, then driven joints to their devices
  const byId = new Map(asm.joints.map((j) => [j.id, j]));
  const effective = new Map<string, number>(joints);
  const order = [...asm.joints].sort((a, b) => depthOf(b, byId) - depthOf(a, byId));
  for (const j of order) {
    if (j.drive && 'follow' in j.drive) {
      const t = effective.get(j.id) ?? 0;
      effective.set(j.drive.follow, (effective.get(j.drive.follow) ?? 0) + t * (j.drive.ratio ?? 1));
    }
  }
  const actuators = new Map<string, ActuatorLoad>();
  for (const j of asm.joints) {
    if (!j.drive || !('device' in j.drive)) continue;
    const mount = asm.mounts?.find((m) => m.device === (j.drive as { device: string }).device);
    if (!mount || (mount.kind !== 'servo' && mount.kind !== 'stepper')) continue;
    const [f0, f1] = j.drive.from ?? [0, 180];
    const [t0, t1] = j.drive.to ?? j.drive.from ?? [0, 180];
    const ratio = (t1 - t0) / (f1 - f0); // joint degrees per device degree
    const tauDev = (effective.get(j.id) ?? 0) * ratio;
    const prev = actuators.get(mount.device);
    actuators.set(mount.device, {
      device: mount.device,
      kind: mount.kind,
      torqueKgfCm: (prev?.torqueKgfCm ?? 0) + tauDev / 10_000, // gf·mm → kgf·cm
      limitKgfCm: mount.kind === 'servo' ? SPEC.sg90.stallTorqueKgfCm : SPEC.nema17.holdingTorqueKgfCm,
      joints: [...(prev?.joints ?? []), j.id],
    });
  }
  return { joints, actuators, totalMassG: bodies.reduce((s, b) => s + b.m, 0) };
}

const subtreeCache = new WeakMap<Assembly, Map<string, Set<string>>>();

/** For every link, the set of links at or below it (cached per assembly object). */
function subtrees(asm: Assembly): Map<string, Set<string>> {
  let hit = subtreeCache.get(asm);
  if (hit) return hit;
  const children = new Map<string, string[]>();
  for (const j of asm.joints) children.set(j.parent, [...(children.get(j.parent) ?? []), j.child]);
  hit = new Map();
  const walk = (id: string): Set<string> => {
    const known = hit!.get(id);
    if (known) return known;
    const set = new Set<string>([id]);
    for (const c of children.get(id) ?? []) for (const x of walk(c)) set.add(x);
    hit!.set(id, set);
    return set;
  };
  for (const l of asm.links) walk(l.id);
  subtreeCache.set(asm, hit);
  return hit;
}

function depthOf(j: Joint, byId: Map<string, Joint>): number {
  let d = 0;
  let cur: Joint | undefined = j;
  while (cur?.drive && 'follow' in cur.drive && d < 64) {
    cur = byId.get(cur.drive.follow);
    d++;
  }
  return d;
}

export interface Clash {
  a: string;
  b: string;
  volumeMm3: number;
}

/** Report threshold: overlaps smaller than this are treated as touching (a reporting choice, not physics). */
export const CLASH_MIN_MM3 = 1;

/** Parts that overlap in the given pose (parts joined directly by a joint are skipped: hinges overlap by design). */
export async function interference(asm: Assembly, values: Map<string, number>): Promise<Clash[]> {
  const M = await manifoldModule();
  const frames = linkFrames(asm, values);
  const adjacent = new Set(asm.joints.map((j) => [j.parent, j.child].sort().join('|')));
  const solids = asm.links
    .map((l) => {
      const s = linkSolid(M, l);
      if (!s) return null;
      const w = s.transform(frames.get(l.id)!.elements as unknown as Parameters<typeof s.transform>[0]);
      s.delete();
      return { id: l.id, solid: w, box: w.boundingBox() };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  const out: Clash[] = [];
  for (let i = 0; i < solids.length; i++)
    for (let k = i + 1; k < solids.length; k++) {
      const A = solids[i];
      const B = solids[k];
      if (adjacent.has([A.id, B.id].sort().join('|'))) continue;
      if ([0, 1, 2].some((d) => A.box.max[d] < B.box.min[d] || B.box.max[d] < A.box.min[d])) continue;
      const x = A.solid.intersect(B.solid);
      const v = x.volume();
      x.delete();
      if (v > CLASH_MIN_MM3) out.push({ a: A.id, b: B.id, volumeMm3: v });
    }
  for (const s of solids) s.solid.delete();
  return out.sort((p, q) => q.volumeMm3 - p.volumeMm3);
}

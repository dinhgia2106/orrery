// Tendons: a line pulled by a spool on an actuator shaft, routed through guides and sheaths to an anchor on a
// moving link. The geometry is exact for what is modelled: the line is straight between guides, wraps a joint's
// round end where the straight path would cut through it, leaves the spool on the tangent and keeps a constant
// length inside a sheath (a Bowden cable). Comparing the path length with what the spool has reeled in tells
// whether the line goes slack or would have to stretch — a real check of a tendon design. Line stretch,
// friction in guides and sheaths, and the line's own mass are not modelled.
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { SPEC } from '../sim/catalog';
import { jointValues, type Assembly, type Joint, type Mount, type Tendon } from './assembly';
import { linkFrames } from './physics';

const DEG = Math.PI / 180;

/**
 * Printed spool on the actuator shaft (a design, not a datasheet part): it seats where the SG90 horn does, 2 mm
 * above the 29 mm case, and carries two grooves 2.5 mm apart — one per winding direction, so a flexor and its
 * extensor can share a servo. For a NEMA 17 the spool sits on the 5 mm shaft, 8 mm out from the face.
 */
export const SPOOL = {
  servoSeatMm: SPEC.sg90.heightMm + 2,
  grooveMm: { 1: 1.5, [-1]: 4 } as Record<1 | -1, number>,
  thicknessMm: 5.5,
  stepperSeatMm: 8,
};

/** The spool's groove centre and shaft axis on the bench (mm), in a mount placed by `frame`. */
export function spoolAxis(mount: Mount, frame: Matrix4, wind: 1 | -1): { c: Vector3; n: Vector3 } {
  const m = frame.clone().multiply(mountMatrix(mount));
  const g = SPOOL.grooveMm[wind];
  const local = mount.kind === 'stepper' ? new Vector3(0, 0, SPOOL.stepperSeatMm + g) : new Vector3(0, SPOOL.servoSeatMm + g, 0);
  const axis = mount.kind === 'stepper' ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
  return { c: local.applyMatrix4(m), n: axis.transformDirection(m) };
}

export function mountMatrix(m: Mount): Matrix4 {
  const r = (m.rotation ?? [0, 0, 0]).map((a) => a * DEG) as [number, number, number];
  return new Matrix4().compose(new Vector3(...m.position), new Quaternion().setFromEuler(new Euler(...r)), new Vector3(1, 1, 1));
}

function jointMatrix(j: Joint): Matrix4 {
  const r = (j.rotation ?? [0, 0, 0]).map((a) => a * DEG) as [number, number, number];
  return new Matrix4().compose(new Vector3(...j.position), new Quaternion().setFromEuler(new Euler(...r)), new Vector3(1, 1, 1));
}

/** Device angle (degrees) that puts the joint it drives at its home value. */
export function deviceHome(asm: Assembly, device: string): number {
  for (const j of asm.joints) {
    const d = j.drive;
    if (!d || !('device' in d) || d.device !== device) continue;
    const [f0, f1] = d.from ?? [0, 180];
    const [t0, t1] = d.to ?? d.from ?? [0, 180];
    if (t1 === t0) continue;
    return f0 + ((j.home ?? 0) - t0) * ((f1 - f0) / (t1 - t0));
  }
  return asm.mounts?.find((m) => m.device === device)?.kind === 'stepper' ? 0 : 90;
}

export interface TendonState {
  /** The line on the bench (mm): the turns wound on the spool, then the free line to the anchor. */
  points: Vector3[];
  /** Per segment (points[i] → points[i+1]): inside a sheath. */
  sheathed: boolean[];
  /** Distance of every point from the anchor along the line (mm) — fixed on the line's material. */
  along: number[];
  /** Line length from the spool tangent to the anchor (sheaths at their constant length), mm. */
  length: number;
  /** Slack in the line (mm): > 0 it hangs loose, < 0 the geometry asks it to stretch by that much. */
  slack: number;
}

/**
 * Everything about one tendon that does not change while it moves: the sheath lengths and the line length at
 * home, so later poses can be compared with what the spool has reeled in.
 */
export class TendonModel {
  private readonly mount: Mount;
  private readonly joints: Map<string, Joint>;
  private sheathLen: number[] = [];
  private home = 0;
  readonly homeAngle: number;

  constructor(
    readonly asm: Assembly,
    readonly tendon: Tendon,
    homeFrames: Map<string, Matrix4>,
  ) {
    this.mount = asm.mounts!.find((m) => m.device === tendon.device)!;
    this.joints = new Map(asm.joints.map((j) => [j.id, j]));
    this.homeAngle = deviceHome(asm, tendon.device);
    const s = this.route(homeFrames, this.homeAngle, null);
    this.sheathLen = s.sheaths;
    this.home = s.length;
  }

  /** The line in this pose: link frames on the bench (mm) and the device angle (degrees). */
  at(frames: Map<string, Matrix4>, deviceAngle: number): TendonState {
    const r = this.route(frames, deviceAngle, this.sheathLen);
    const reeled = this.tendon.wind * this.tendon.spool * (deviceAngle - this.homeAngle) * DEG;
    return { points: r.points, sheathed: r.sheathed, along: r.along, length: r.length, slack: this.home - reeled - r.length };
  }

  private route(frames: Map<string, Matrix4>, deviceAngle: number, sheathLen: number[] | null) {
    const t = this.tendon;
    const pts: Vector3[] = [];
    const sheathed: boolean[] = [];
    const sheaths: number[] = [];
    const world = (p: { link: string; at: [number, number, number] }) => new Vector3(...p.at).applyMatrix4(frames.get(p.link)!);
    // free line, from the first guide on: guides, wraps, anchor
    const free: Vector3[] = [];
    const inSheath: boolean[] = [];
    const path = t.path;
    for (let k = 0; k < path.length; k++) {
      const p = path[k];
      if ('wrap' in p) {
        const next = path.slice(k + 1).find((x): x is Extract<typeof x, { link: string }> => 'link' in x);
        if (!next || !free.length) continue;
        const arc = this.wrap(free[free.length - 1], world(next), p.wrap, p.r, frames, p.sense);
        for (const q of arc) (free.push(q), inSheath.push(false));
      } else {
        free.push(world(p));
        inSheath.push(!!p.sheath);
      }
    }
    // spool: the line leaves the groove on the tangent that reels it in as the device turns `wind`-wise
    const { c, n } = spoolAxis(this.mount, frames.get(this.mount.link)!, t.wind);
    const target = free[0];
    const rel = target.clone().sub(c);
    const axial = rel.dot(n);
    const flat = rel.clone().addScaledVector(n, -axial);
    const d = Math.max(flat.length(), t.spool * 1.0001);
    const u = flat.normalize();
    const v = new Vector3().crossVectors(n, u);
    const beta = Math.acos(Math.min(1, t.spool / d));
    // tangent point at angle +β (wind 1) or −β from u: there the groove moves away from the line as it reels in
    const tan = (a: number) => c.clone().addScaledVector(u, t.spool * Math.cos(a)).addScaledVector(v, t.spool * Math.sin(a));
    const a0 = t.wind * beta;
    // the turns already on the spool (drawn as a flat helix): more as it reels in, never less than a quarter turn
    const wound = Math.max(0.5 * Math.PI, 1.25 * Math.PI + t.wind * (deviceAngle - this.homeAngle) * DEG);
    const steps = Math.max(6, Math.ceil(wound / 0.25));
    for (let i = steps; i >= 1; i--) {
      const a = a0 + t.wind * (wound * i) / steps;
      pts.push(tan(a).addScaledVector(n, (-0.6 * t.wind * (wound * i)) / steps / (2 * Math.PI)));
      sheathed.push(false);
    }
    pts.push(tan(a0));
    sheathed.push(false);
    for (let i = 0; i < free.length; i++) {
      pts.push(free[i]);
      sheathed.push(inSheath[i]);
    }
    sheathed.pop(); // one flag per segment
    // length: tangent → anchor, a sheath counting its home length
    let length = 0;
    const first = steps; // index of the tangent point
    let s = 0;
    for (let i = first; i < pts.length - 1; i++) {
      const seg = pts[i].distanceTo(pts[i + 1]);
      if (sheathed[i]) {
        const L = sheathLen ? sheathLen[s] : seg;
        sheaths.push(L);
        length += L;
        s++;
      } else length += seg;
    }
    // distance from the anchor along the line, for drawing marks that travel with it
    const along = new Array<number>(pts.length).fill(0);
    s = sheaths.length - 1;
    for (let i = pts.length - 2; i >= 0; i--) {
      const seg = pts[i].distanceTo(pts[i + 1]);
      along[i] = along[i + 1] + (sheathed[i] && i >= first ? sheaths[s--] : seg);
    }
    return { points: pts, sheathed, along, length, sheaths };
  }

  /**
   * The line from a to b around joint `id`'s round end (radius r about its axis): straight if that clears the
   * circle, else tangent → arc → tangent on the side the straight line passes.
   */
  private wrap(a: Vector3, b: Vector3, id: string, r: number, frames: Map<string, Matrix4>, given?: 1 | -1): Vector3[] {
    const j = this.joints.get(id)!;
    const m = frames.get(j.parent)!.clone().multiply(jointMatrix(j));
    const o = new Vector3().setFromMatrixPosition(m);
    const ax = new Vector3(...(j.axis ?? [0, 0, 1])).normalize().transformDirection(m);
    const e1 = Math.abs(ax.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
    e1.addScaledVector(ax, -e1.dot(ax)).normalize();
    const e2 = new Vector3().crossVectors(ax, e1);
    const to2 = (p: Vector3) => {
      const q = p.clone().sub(o);
      return { x: q.dot(e1), y: q.dot(e2), h: q.dot(ax) };
    };
    const A = to2(a);
    const B = to2(b);
    const dA = Math.hypot(A.x, A.y);
    const dB = Math.hypot(B.x, B.y);
    if (dA <= r || dB <= r) return [];
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const tt = Math.max(0, Math.min(1, -(A.x * dx + A.y * dy) / Math.max(1e-12, dx * dx + dy * dy)));
    // the straight line passes the axis anticlockwise when the cross product is positive
    const straight = Math.sign(A.x * B.y - A.y * B.x) || 1;
    const wrongSide = given !== undefined && given !== straight;
    if (!wrongSide && Math.hypot(A.x + tt * dx, A.y + tt * dy) >= r) return [];
    const sense = given ?? straight;
    const t1 = Math.atan2(A.y, A.x) + sense * Math.acos(r / dA);
    const t2 = Math.atan2(B.y, B.x) - sense * Math.acos(r / dB);
    let phi = sense * (t2 - t1);
    while (phi < 0) phi += 2 * Math.PI;
    while (phi > 2 * Math.PI) phi -= 2 * Math.PI;
    const n = Math.max(2, Math.ceil(phi / 0.2));
    const out: Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      const ang = t1 + (sense * phi * i) / n;
      const h = A.h + ((B.h - A.h) * (i + 1)) / (n + 2);
      out.push(o.clone().addScaledVector(e1, r * Math.cos(ang)).addScaledVector(e2, r * Math.sin(ang)).addScaledVector(ax, h));
    }
    return out;
  }
}

/**
 * Share of the actuator's torque that tensions this line (0–1): the actuator pulls it only when turning
 * `wind`-wise. A line the geometry asks to stretch is reported by its slack, not given a made-up tension: the
 * kinematic drive moves the joints regardless, so that stretch is a design mismatch, not a measured force.
 */
export function tensionShare(t: Tendon, actuatorFraction: number): number {
  return Math.max(0, Math.min(1, t.wind * actuatorFraction));
}

const models = new WeakMap<Assembly, TendonModel[]>();
/** The tendon models of an assembly (built once per assembly object). */
export function tendonModels(asm: Assembly): TendonModel[] {
  let m = models.get(asm);
  if (!m) {
    const home = linkFrames(asm, jointValues(asm, (d) => deviceHome(asm, d)));
    m = (asm.tendons ?? []).map((t) => new TendonModel(asm, t, home));
    models.set(asm, m);
  }
  return m;
}

export interface TendonReading {
  id: string;
  label?: string;
  device: string;
  /** Share of the actuator's limit torque in this line (0–1) and the tension that makes (N). */
  share: number;
  tensionN: number;
  /** > 0 slack, < 0 the geometry asks it to stretch (mm). */
  slackMm: number;
}

/**
 * Every line's tension and slack in a pose: tension = share of the actuator's stall (SG90, 1.8 kgf·cm) or holding
 * (NEMA 17) torque ÷ spool radius — the line is taken as inextensible and frictionless.
 */
export function readTendons(asm: Assembly, frames: Map<string, Matrix4>, deviceAngle: (d: string) => number | undefined, effort: (d: string) => number | undefined): TendonReading[] {
  return tendonModels(asm).map((m) => {
    const t = m.tendon;
    const st = m.at(frames, deviceAngle(t.device) ?? m.homeAngle);
    const share = tensionShare(t, effort(t.device) ?? 0);
    const stepper = asm.mounts?.find((x) => x.device === t.device)?.kind === 'stepper';
    const limitNm = (stepper ? SPEC.nema17.holdingTorqueKgfCm : SPEC.sg90.stallTorqueKgfCm) * 9.80665 * 0.01;
    return { id: t.id, label: t.label, device: t.device, share, tensionN: (share * limitNm) / (t.spool / 1000), slackMm: st.slack };
  });
}

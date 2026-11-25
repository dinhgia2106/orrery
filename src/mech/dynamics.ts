// Rigid-body dynamics of a mechanism with Rapier: real masses, gravity, inertia, torque-limited joint motors
// (the SG90's stall torque, the NEMA 17's holding torque) and contacts with the bench and loose objects.
//
// Units inside Rapier are SI (m, kg, s, N·m); the assembly is in mm. Each link is a rigid body whose frame is
// the link frame; joint angles are measured from the bodies' orientations, so a joint's zero is exactly the
// assembly's home pose.
import type RAPIER_T from '@dimforge/rapier3d-compat';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { SPEC } from '../sim/catalog';
import type { Assembly, Joint, Vec3 } from './assembly';
import { MOUNT_MASS, linkFrames, type MassProps } from './physics';

type R = typeof RAPIER_T;
let loading: Promise<R> | null = null;

/** Loads Rapier's WebAssembly once. */
export function loadRapier(): Promise<R> {
  loading ??= import('@dimforge/rapier3d-compat').then(async (m) => {
    const lib = (m.default ?? m) as R;
    await lib.init();
    return lib;
  });
  return loading;
}

const MM = 0.001;
/** Standard gravity g_n = 9.80665 m/s² (the conventional value, 3rd CGPM 1901). */
export const G = 9.80665;
/** 1 kgf·cm in N·m. */
export const KGFCM = G * 0.01;
const DEG = Math.PI / 180;
/** Physics step: 1/240 s. */
export const DT = 1 / 240;
/**
 * Position-loop gain of the joint motors (1/s): velocity target = gain × angle error, then clamped to the
 * actuator's speed and torque. A control choice that makes joints track like a hobby servo — not a datasheet value.
 */
export const SERVO_GAIN = 25;
/** How hard a motor works to reach its target velocity (N·m·s/rad), always capped by the torque limit. A control choice. */
const MOTOR_DAMPING = 10;

// collision groups: mechanism parts touch each other, the bench and loose objects. Two parts never collide when
// a joint joins them directly, or when they already overlap in the home pose (hinge knuckles, servos seated in
// pockets): those are designed overlaps, and pushing them apart would tear the mechanism.
const GROUP_MECH = (0x0001 << 16) | 0x0003;
const GROUP_WORLD = (0x0002 << 16) | 0x0003;
/**
 * Numerical conditioning, not a datasheet value. Rapier solves joints iteratively, and a chain with a very light
 * link between heavy ones (a 2 g finger knuckle between a 266 g palm and the finger) does not converge: the joint
 * gives way under loads far below the actuator's torque. Every moving body therefore gets at least this rotational
 * inertia about each principal axis (1e-5 kg·m² ≈ 10 g at a 32 mm radius of gyration). Masses, centres of mass and
 * so gravity loads are unchanged; very light parts only respond more slowly to impacts than they would for real.
 */
const MIN_INERTIA = 1e-5;
/** Solver iterations per step, and internal PGS iterations per solver iteration (Rapier defaults: 4 and 1). */
const SOLVER_ITERATIONS = 8;
const PGS_ITERATIONS = 4;
/** Parts closer than this in the home pose count as overlapping (m): 0.3 mm. */
const REST_GAP = 0.0003;
/** Parts closer than this while moving count as touching (m): 0.1 mm. */
const TOUCH_GAP = 0.0001;

interface JointRt {
  joint: Joint;
  rj: RAPIER_T.RevoluteImpulseJoint;
  parent: RAPIER_T.RigidBody;
  child: RAPIER_T.RigidBody;
  /** Rotation of the joint frame in the parent body frame. */
  frameQ: Quaternion;
  axis: Vector3;
  /** Joint degrees per device degree, the device's speed and torque at the joint. */
  drive?: { device: string; f0: number; t0: number; ratio: number; maxVel: number; maxTorque: number; deviceTorque: number };
}

export interface LoosePart {
  id: string;
  kind: 'ball' | 'box';
  sizeMm: number;
  body: RAPIER_T.RigidBody;
}

export interface Pose {
  p: Vec3;
  q: [number, number, number, number];
}

export interface ActuatorTrack {
  device: string;
  /** Commanded joint angle (from the device) and the angle the dynamics reached, degrees. */
  commanded: number;
  actual: number;
}

export class Dynamics {
  readonly world: RAPIER_T.World;
  private readonly bodies = new Map<string, RAPIER_T.RigidBody>();
  private readonly joints: JointRt[] = [];
  readonly loose: LoosePart[] = [];
  private acc = 0;
  private seq = 0;
  /** Mechanism colliders: which link each belongs to. */
  private readonly mech = new Map<number, string>();
  /** Link pairs left out of collision: overlapping in the home pose, or joined by a hinge. */
  private readonly ignored = new Set<string>();
  private readonly hinged = new Set<string>();
  /** Rapier only runs the contact hooks when stepping with an event queue; nothing reads its events. */
  private readonly queue: RAPIER_T.EventQueue;
  /** Each link's rigid body (links on fixed joints share their parent's) and the link frame inside it (mm). */
  private readonly linkBody = new Map<string, RAPIER_T.RigidBody>();
  private readonly offsets = new Map<string, Matrix4>();
  private readonly hooks: RAPIER_T.PhysicsHooks;

  constructor(
    private readonly lib: R,
    readonly asm: Assembly,
    props: Map<string, MassProps>,
    start: Map<string, number>,
  ) {
    const world = new lib.World({ x: 0, y: -G, z: 0 });
    world.timestep = DT;
    world.integrationParameters.numSolverIterations = SOLVER_ITERATIONS;
    world.integrationParameters.numInternalPgsIterations = PGS_ITERATIONS;
    this.world = world;

    // bench top: a fixed slab whose surface is y = 0
    const ground = world.createRigidBody(lib.RigidBodyDesc.fixed().setTranslation(0, -0.005, 0));
    world.createCollider(lib.ColliderDesc.cuboid(5, 0.005, 5).setCollisionGroups(GROUP_WORLD), ground);

    const frames = linkFrames(asm, start);
    const rootId = asm.links.find((l) => !asm.joints.some((j) => j.child === l.id))!.id;
    // links held by a fixed joint (and, for now, a prismatic one) are part of their parent's rigid body: one body,
    // several colliders. A chain of light bodies tied by impulse joints is soft — a motor at stall could push a
    // fixed part out of its way — while a compound body is exactly rigid.
    const parentJoint = new Map(asm.joints.map((j) => [j.child, j]));
    const bodyOf = (id: string, depth = 0): string => {
      const j = parentJoint.get(id);
      return j && j.type !== 'revolute' && depth < 64 ? bodyOf(j.parent, depth + 1) : id;
    };
    for (const l of asm.links) {
      const b = bodyOf(l.id);
      if (!this.bodies.has(b)) {
        const p = new Vector3();
        const q = new Quaternion();
        frames.get(b)!.decompose(p, q, new Vector3());
        const desc = (b === rootId ? lib.RigidBodyDesc.fixed() : lib.RigidBodyDesc.dynamic()).setTranslation(p.x * MM, p.y * MM, p.z * MM).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
        this.bodies.set(b, world.createRigidBody(desc));
      }
      // the link's frame inside its body's frame (mm)
      this.offsets.set(l.id, new Matrix4().copy(frames.get(b)!).invert().multiply(frames.get(l.id)!));
      this.linkBody.set(l.id, this.bodies.get(b)!);
    }

    /** A pose given in a link's frame (mm, rotation), expressed in its body's frame (m). */
    const inBody = (link: string, pos: Vec3, rot: Quaternion) => {
      const m = new Matrix4().compose(new Vector3(...pos), rot, new Vector3(1, 1, 1)).premultiply(this.offsets.get(link)!);
      const t = new Vector3();
      const r = new Quaternion();
      m.decompose(t, r, new Vector3());
      return { t: { x: t.x * MM, y: t.y * MM, z: t.z * MM }, r: { x: r.x, y: r.y, z: r.z, w: r.w } };
    };
    for (const l of asm.links) {
      const body = this.linkBody.get(l.id)!;
      const mp = props.get(l.id);
      const kg = Math.max(1e-4, (mp?.massG ?? 0) / 1000);
      const shape = l.shape;
      let cd: RAPIER_T.ColliderDesc | null = null;
      if ('box' in shape) cd = lib.ColliderDesc.cuboid((shape.box[0] / 2) * MM, (shape.box[1] / 2) * MM, (shape.box[2] / 2) * MM);
      else if ('cylinder' in shape) cd = lib.ColliderDesc.cylinder((shape.cylinder.h / 2) * MM, shape.cylinder.r * MM);
      else if ('capsule' in shape) cd = lib.ColliderDesc.capsule((shape.capsule.h / 2) * MM, shape.capsule.r * MM);
      else if ('sphere' in shape) cd = lib.ColliderDesc.ball(shape.sphere * MM);
      if (cd) {
        const rq = new Quaternion().setFromEuler(new Euler(...((l.rotation ?? [0, 0, 0]).map((a) => a * DEG) as [number, number, number])));
        const { t, r } = inBody(l.id, l.position ?? [0, 0, 0], rq);
        // the primitive's own inertia with the part's real mass (holes and pockets change the mass, not the shape here)
        this.addMech(world.createCollider(cd.setTranslation(t.x, t.y, t.z).setRotation(r).setMass(kg).setCollisionGroups(GROUP_MECH), body), l.id);
      } else if (!body.isFixed()) {
        body.setAdditionalMass(kg, true); // imported mesh: mass without a collider
      }
    }
    // mounted parts: boxes with their real masses (SG90 case, NEMA 17 body, A4988 board)
    const boxes: Record<string, Vec3> = { servo: [SPEC.sg90.lengthMm, SPEC.sg90.heightMm, SPEC.sg90.widthMm], stepper: [SPEC.nema17.frameMm, SPEC.nema17.frameMm, SPEC.nema17.bodyMm], a4988: [SPEC.a4988.boardMm[0], 1.6, SPEC.a4988.boardMm[1]] };
    for (const mt of asm.mounts ?? []) {
      const mm = MOUNT_MASS[mt.kind];
      const size = boxes[mt.kind];
      const body = this.linkBody.get(mt.link);
      if (!mm || !size || !body) continue;
      const mq = new Quaternion().setFromEuler(new Euler(...((mt.rotation ?? [0, 0, 0]).map((a) => a * DEG) as [number, number, number])));
      const c = new Vector3(...mm.com).applyQuaternion(mq).add(new Vector3(...mt.position));
      const { t, r } = inBody(mt.link, [c.x, c.y, c.z], mq);
      const cd = lib.ColliderDesc.cuboid((size[0] / 2) * MM, (size[1] / 2) * MM, (size[2] / 2) * MM)
        .setTranslation(t.x, t.y, t.z)
        .setRotation(r)
        .setMass(mm.g / 1000)
        .setCollisionGroups(GROUP_MECH);
      this.addMech(world.createCollider(cd, body), mt.link);
    }

    for (const b of new Set(this.linkBody.values())) {
      if (!b.isDynamic()) continue;
      const I = b.principalInertia();
      const add = { x: Math.max(0, MIN_INERTIA - I.x), y: Math.max(0, MIN_INERTIA - I.y), z: Math.max(0, MIN_INERTIA - I.z) };
      if (add.x || add.y || add.z) b.setAdditionalMassProperties(0, { x: 0, y: 0, z: 0 }, add, b.principalInertiaLocalFrame(), true);
    }

    for (const j of asm.joints) {
      if (j.type !== 'revolute') continue; // fixed and prismatic links were merged into their parent's body above
      const parent = this.linkBody.get(j.parent)!;
      const child = this.linkBody.get(j.child)!;
      const off = this.offsets.get(j.parent)!;
      // the joint frame in the parent *body* frame
      const frameQ = new Quaternion().setFromRotationMatrix(off).multiply(new Quaternion().setFromEuler(new Euler(...((j.rotation ?? [0, 0, 0]).map((a) => a * DEG) as [number, number, number]))));
      const axis = new Vector3(...(j.axis ?? [0, 0, 1])).normalize();
      const at = new Vector3(...j.position).applyMatrix4(off);
      // child frame = joint frame × rotation about the axis, so the axis is the same vector in the child frame
      const a1 = axis.clone().applyQuaternion(frameQ);
      const data = lib.JointData.revoluteWithAxes({ x: at.x * MM, y: at.y * MM, z: at.z * MM }, { x: 0, y: 0, z: 0 }, { x: a1.x, y: a1.y, z: a1.z }, { x: axis.x, y: axis.y, z: axis.z });
      const rj = world.createImpulseJoint(data, parent, child, true) as RAPIER_T.RevoluteImpulseJoint;
      // force-based: the motor's max force is a real torque limit in N·m (the acceleration-based model limits acceleration instead)
      rj.configureMotorModel(lib.MotorModel.ForceBased);
      this.hinged.add(linkKey(j.parent, j.child)); // a hinge's two parts overlap at the pin by design
      const rt: JointRt = { joint: j, rj, parent, child, frameQ, axis };
      if (j.drive && 'device' in j.drive) {
        const mount = asm.mounts?.find((m) => m.device === (j.drive as { device: string }).device);
        const [f0, f1] = j.drive.from ?? [0, 180];
        const [t0, t1] = j.drive.to ?? j.drive.from ?? [0, 180];
        const ratio = (t1 - t0) / (f1 - f0);
        const servo = mount?.kind !== 'stepper';
        const deviceTorque = (servo ? SPEC.sg90.stallTorqueKgfCm : SPEC.nema17.holdingTorqueKgfCm) * KGFCM;
        const deviceSpeed = servo ? 60 / SPEC.sg90.secPer60Deg : SPEC.nema17.maxStepsPerSecApprox * (360 / SPEC.nema17.stepsPerRev);
        rt.drive = { device: j.drive.device, f0, t0, ratio, maxVel: Math.abs(ratio) * deviceSpeed * DEG, maxTorque: deviceTorque / Math.max(1e-6, Math.abs(ratio)), deviceTorque };
      }
      this.joints.push(rt);
    }

    // designed overlaps: colliders of two different links on different bodies that touch in the home pose
    const list = [...this.mech.keys()].map((h) => world.getCollider(h));
    for (let i = 0; i < list.length; i++)
      for (let k = i + 1; k < list.length; k++) {
        const a = list[i];
        const b = list[k];
        const la = this.mech.get(a.handle)!;
        const lb = this.mech.get(b.handle)!;
        if (la === lb || a.parent()!.handle === b.parent()!.handle || this.hinged.has(linkKey(la, lb))) continue;
        if (a.shape.contactShape(a.translation(), a.rotation(), b.shape, b.translation(), b.rotation(), REST_GAP)) this.ignored.add(linkKey(la, lb));
      }
    this.queue = new lib.EventQueue(true);
    const skip = (c1: number, c2: number) => {
      const a = this.mech.get(c1);
      const b = this.mech.get(c2);
      if (!a || !b) return false; // the bench and loose objects always collide
      const k = linkKey(a, b);
      return this.hinged.has(k) || this.ignored.has(k);
    };
    this.hooks = {
      filterContactPair: (c1, c2) => (skip(c1, c2) ? null : lib.SolverFlags.COMPUTE_IMPULSE),
      filterIntersectionPair: (c1, c2) => !skip(c1, c2),
    };
  }

  private addMech(c: RAPIER_T.Collider, link: string): void {
    c.setActiveHooks(this.lib.ActiveHooks.FILTER_CONTACT_PAIRS);
    this.mech.set(c.handle, link);
  }

  /**
   * Pairs of mechanism parts touching right now (within TOUCH_GAP or overlapping), jointed neighbours and
   * designed overlaps excluded. Read from the contact manifolds: Rapier also keeps predictive contacts for
   * parts that are merely close, so a pair counts only when its nearest contact point is actually closed.
   */
  touching(): { a: string; b: string }[] {
    const found = new Set<string>();
    for (const [h, a] of this.mech) {
      const c = this.world.getCollider(h);
      this.world.contactPairsWith(c, (o) => {
        const b = this.mech.get(o.handle);
        if (!b || a === b) return;
        const k = linkKey(a, b);
        if (found.has(k) || this.hinged.has(k) || this.ignored.has(k)) return;
        this.world.contactPair(c, o, (m) => {
          for (let i = 0; i < m.numContacts(); i++) if (m.contactDist(i) <= TOUCH_GAP) return void found.add(k);
        });
      });
    }
    return [...found].sort().map((k) => {
      const [a, b] = k.split('|');
      return { a, b };
    });
  }

  /** Link pairs left out of collision because they overlap in the home pose. */
  restOverlaps(): number {
    return this.ignored.size;
  }

  /** Joint angle in degrees, measured from the two bodies (0 = home pose). */
  angle(rt: JointRt): number {
    const qp = new Quaternion().copy(rt.parent.rotation() as Quaternion).multiply(rt.frameQ);
    const rel = qp.invert().multiply(new Quaternion().copy(rt.child.rotation() as Quaternion));
    const s = rel.x * rt.axis.x + rel.y * rt.axis.y + rel.z * rt.axis.z;
    return (2 * Math.atan2(s, rel.w)) / DEG;
  }

  /** Advance by `seconds` (in 1/240 s steps), driving joints from the devices' angles. */
  step(seconds: number, deviceAngle: (device: string) => number | undefined): void {
    this.acc += seconds;
    while (this.acc >= DT) {
      this.acc -= DT;
      this.drive(deviceAngle);
      this.world.step(this.queue, this.hooks);
    }
  }

  private drive(deviceAngle: (device: string) => number | undefined): void {
    const angles = new Map<string, number>();
    for (const rt of this.joints) angles.set(rt.joint.id, this.angle(rt));
    const byId = new Map(this.joints.map((rt) => [rt.joint.id, rt]));
    for (const rt of this.joints) {
      const rj = rt.rj;
      const j = rt.joint;
      const now = angles.get(j.id)!;
      let target: number | undefined;
      let maxVel = Infinity;
      let maxTorque = 0;
      if (rt.drive) {
        const a = deviceAngle(rt.drive.device);
        if (a !== undefined) target = rt.drive.t0 + (a - rt.drive.f0) * rt.drive.ratio;
        maxVel = rt.drive.maxVel;
        maxTorque = rt.drive.maxTorque;
      } else if (j.drive && 'follow' in j.drive) {
        // a tendon or gear: track the source joint's actual angle, with the source actuator's torque scaled by the ratio
        const src = byId.get(j.drive.follow);
        const k = j.drive.ratio ?? 1;
        target = k * (angles.get(j.drive.follow) ?? 0) + (j.drive.offset ?? 0);
        const root = src ? this.driverOf(src, byId) : undefined;
        maxVel = root ? root.maxVel * Math.abs(k) : Infinity;
        maxTorque = root ? root.maxTorque / Math.max(1e-6, Math.abs(k)) : 0;
      }
      if (target !== undefined && j.limits) target = Math.min(j.limits[1], Math.max(j.limits[0], target));
      // hard stops: a joint pushed past a limit is held back strongly — unless its actuator is already pulling it
      // back inside, which it must stay free to do (otherwise a joint that overshoots a stop by a hair sticks there)
      const pullsBack = target !== undefined && j.limits && ((now > j.limits[1] && target < j.limits[1]) || (now < j.limits[0] && target > j.limits[0]));
      if (j.limits && (now < j.limits[0] || now > j.limits[1]) && !pullsBack) {
        target = Math.min(j.limits[1], Math.max(j.limits[0], now));
        maxTorque = Math.max(maxTorque, 100);
        maxVel = Infinity;
      }
      if (target === undefined) {
        rj.setMotorMaxForce(0);
        continue;
      }
      const vel = Math.max(-maxVel, Math.min(maxVel, SERVO_GAIN * (target - now) * DEG));
      rj.configureMotorVelocity(vel, MOTOR_DAMPING);
      rj.setMotorMaxForce(maxTorque);
    }
  }

  private driverOf(rt: JointRt, byId: Map<string, JointRt>, depth = 0): JointRt['drive'] {
    if (rt.drive || depth > 32) return rt.drive;
    const j = rt.joint;
    if (j.drive && 'follow' in j.drive) {
      const src = byId.get(j.drive.follow);
      const d = src ? this.driverOf(src, byId, depth + 1) : undefined;
      return d ? { ...d, maxVel: d.maxVel * Math.abs(j.drive.ratio ?? 1), maxTorque: d.maxTorque / Math.max(1e-6, Math.abs(j.drive.ratio ?? 1)) } : undefined;
    }
    return undefined;
  }

  /**
   * How hard each actuator works right now, as a signed share of its stall (servo) or holding (stepper) torque,
   * positive towards increasing device angle. Quasi-static: at each joint the actuator holds everything beyond it
   * against gravity and against the contact forces other parts and objects put on it (from the solver's contact
   * impulses in the last step), and joints it drives through a tendon or gear ("follow") count by virtual work —
   * joint torque × joint degrees per device degree. Inertial torques while accelerating are left out.
   */
  actuatorEfforts(): Map<string, number> {
    const parentOf = new Map<RAPIER_T.RigidBody, RAPIER_T.RigidBody>();
    for (const rt of this.joints) parentOf.set(rt.child, rt.parent);
    const within = (b: RAPIER_T.RigidBody | null | undefined, root: RAPIER_T.RigidBody) => {
      for (let x = b ?? undefined, d = 0; x && d < 64; x = parentOf.get(x), d++) if (x === root) return true;
      return false;
    };
    // external loads on every moving body: its weight at its centre of mass, and every contact force
    const loads = new Map<RAPIER_T.RigidBody, { p: Vector3; f: Vector3; from: RAPIER_T.RigidBody | null }[]>();
    const add = (b: RAPIER_T.RigidBody, l: { p: Vector3; f: Vector3; from: RAPIER_T.RigidBody | null }) => {
      const list = loads.get(b);
      if (list) list.push(l);
      else loads.set(b, [l]);
    };
    for (const b of new Set(this.linkBody.values())) {
      if (!b.isDynamic()) continue;
      const c = b.worldCom();
      add(b, { p: new Vector3(c.x, c.y, c.z), f: new Vector3(0, -G * b.mass(), 0), from: null });
    }
    const q = new Quaternion();
    for (const h of this.mech.keys()) {
      const c = this.world.getCollider(h);
      const b = c.parent();
      if (!b || !b.isDynamic()) continue;
      this.world.contactPairsWith(c, (o) => {
        this.world.contactPair(c, o, (m, flipped) => {
          const n = m.normal();
          for (let i = 0; i < m.numContacts(); i++) {
            const imp = m.contactImpulse(i);
            const lp = flipped ? m.localContactPoint2(i) : m.localContactPoint1(i);
            if (!(imp > 0) || !lp) continue;
            const t = c.translation();
            const p = new Vector3(lp.x, lp.y, lp.z).applyQuaternion(q.copy(c.rotation() as Quaternion)).add(new Vector3(t.x, t.y, t.z));
            // the normal points from the manifold's first shape to its second; each shape is pushed away from the other
            const s = (flipped ? 1 : -1) * (imp / DT);
            add(b, { p, f: new Vector3(n.x * s, n.y * s, n.z * s), from: o.parent() });
          }
        });
      });
    }
    const byId = new Map(this.joints.map((rt) => [rt.joint.id, rt]));
    const chain = (rt: JointRt, depth = 0): { d: NonNullable<JointRt['drive']>; c: number } | undefined => {
      if (rt.drive) return { d: rt.drive, c: rt.drive.ratio };
      const f = rt.joint.drive;
      if (!f || !('follow' in f) || depth > 32) return undefined;
      const src = byId.get(f.follow);
      const up = src && chain(src, depth + 1);
      return up && { d: up.d, c: up.c * (f.ratio ?? 1) };
    };
    const out = new Map<string, number>();
    for (const rt of this.joints) {
      const ch = chain(rt);
      if (!ch) continue;
      const pr = q.copy(rt.parent.rotation() as Quaternion);
      const ax = rt.axis.clone().applyQuaternion(pr.clone().multiply(rt.frameQ));
      const a1 = rt.rj.anchor1();
      const pt = rt.parent.translation();
      const o = new Vector3(a1.x, a1.y, a1.z).applyQuaternion(pr).add(new Vector3(pt.x, pt.y, pt.z));
      let external = 0;
      for (const [b, list] of loads) {
        if (!within(b, rt.child)) continue;
        for (const l of list) if (!within(l.from, rt.child)) external += l.p.clone().sub(o).cross(l.f).dot(ax);
      }
      // the actuator supplies the opposite of the external torque about the joint
      out.set(ch.d.device, (out.get(ch.d.device) ?? 0) + (-external * ch.c) / ch.d.deviceTorque);
    }
    return out;
  }

  /** World poses of every link (mm). */
  poses(): Map<string, Pose> {
    const out = new Map<string, Pose>();
    const m = new Matrix4();
    const p = new Vector3();
    const q = new Quaternion();
    const one = new Vector3(1, 1, 1);
    for (const [id, b] of this.linkBody) {
      const t = b.translation();
      const r = b.rotation();
      m.compose(p.set(t.x / MM, t.y / MM, t.z / MM), q.set(r.x, r.y, r.z, r.w), one).multiply(this.offsets.get(id)!);
      m.decompose(p, q, new Vector3());
      out.set(id, { p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w] });
    }
    return out;
  }

  /** World matrices of every link frame (mm), like physics.linkFrames. */
  frames(): Map<string, Matrix4> {
    const out = new Map<string, Matrix4>();
    const one = new Vector3(1, 1, 1);
    for (const [id, p] of this.poses()) out.set(id, new Matrix4().compose(new Vector3(...p.p), new Quaternion(...p.q), one));
    return out;
  }

  jointAngles(): Map<string, number> {
    const out = new Map<string, number>();
    for (const rt of this.joints) out.set(rt.joint.id, this.angle(rt));
    return out;
  }

  /** Commanded vs reached angle for every device-driven joint. */
  tracking(deviceAngle: (device: string) => number | undefined): ActuatorTrack[] {
    return this.joints
      .filter((rt) => rt.drive)
      .map((rt) => {
        const a = deviceAngle(rt.drive!.device);
        let commanded = a === undefined ? 0 : rt.drive!.t0 + (a - rt.drive!.f0) * rt.drive!.ratio;
        if (rt.joint.limits) commanded = Math.min(rt.joint.limits[1], Math.max(rt.joint.limits[0], commanded));
        return { device: rt.drive!.device, commanded, actual: this.angle(rt) };
      });
  }

  /** Drop a loose PLA ball or cube (density 1.24 g/cm³) centred at `at` (mm). */
  drop(kind: 'ball' | 'box', sizeMm: number, at: Vec3): LoosePart {
    const lib = this.lib;
    const body = this.world.createRigidBody(lib.RigidBodyDesc.dynamic().setTranslation(at[0] * MM, at[1] * MM, at[2] * MM));
    const volumeCm3 = kind === 'ball' ? ((4 / 3) * Math.PI * (sizeMm / 2) ** 3) / 1000 : sizeMm ** 3 / 1000;
    const cd = (kind === 'ball' ? lib.ColliderDesc.ball((sizeMm / 2) * MM) : lib.ColliderDesc.cuboid((sizeMm / 2) * MM, (sizeMm / 2) * MM, (sizeMm / 2) * MM))
      .setMass((volumeCm3 * 1.24) / 1000)
      .setCollisionGroups(GROUP_WORLD);
    this.world.createCollider(cd, body);
    const part = { id: `loose${++this.seq}`, kind, sizeMm, body };
    this.loose.push(part);
    return part;
  }

  loosePoses(): { id: string; kind: 'ball' | 'box'; sizeMm: number; pose: Pose }[] {
    return this.loose.map((l) => {
      const t = l.body.translation();
      const r = l.body.rotation();
      return { id: l.id, kind: l.kind, sizeMm: l.sizeMm, pose: { p: [t.x / MM, t.y / MM, t.z / MM], q: [r.x, r.y, r.z, r.w] } };
    });
  }

  dispose(): void {
    this.queue.free();
    this.world.free();
  }
}

function linkKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

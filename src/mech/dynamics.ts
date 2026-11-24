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

// collision groups: the mechanism touches the bench and loose objects, not itself (the interference check
// covers part-to-part clashes; parts that overlap at rest would otherwise be pushed apart)
const GROUP_MECH = (0x0001 << 16) | 0x0002;
const GROUP_WORLD = (0x0002 << 16) | 0x0003;

interface JointRt {
  joint: Joint;
  rj: RAPIER_T.RevoluteImpulseJoint | null;
  parent: RAPIER_T.RigidBody;
  child: RAPIER_T.RigidBody;
  /** Rotation of the joint frame in the parent link frame. */
  frameQ: Quaternion;
  axis: Vector3;
  /** Joint degrees per device degree, the device's speed and torque at the joint. */
  drive?: { device: string; f0: number; t0: number; ratio: number; maxVel: number; maxTorque: number };
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

  constructor(
    private readonly lib: R,
    readonly asm: Assembly,
    props: Map<string, MassProps>,
    start: Map<string, number>,
  ) {
    const world = new lib.World({ x: 0, y: -G, z: 0 });
    world.timestep = DT;
    world.integrationParameters.numSolverIterations = 8;
    this.world = world;

    // bench top: a fixed slab whose surface is y = 0
    const ground = world.createRigidBody(lib.RigidBodyDesc.fixed().setTranslation(0, -0.005, 0));
    world.createCollider(lib.ColliderDesc.cuboid(5, 0.005, 5).setCollisionGroups(GROUP_WORLD), ground);

    const frames = linkFrames(asm, start);
    const rootId = asm.links.find((l) => !asm.joints.some((j) => j.child === l.id))!.id;
    for (const l of asm.links) {
      const m = frames.get(l.id)!;
      const p = new Vector3();
      const q = new Quaternion();
      m.decompose(p, q, new Vector3());
      const desc = (l.id === rootId ? lib.RigidBodyDesc.fixed() : lib.RigidBodyDesc.dynamic()).setTranslation(p.x * MM, p.y * MM, p.z * MM).setRotation(q);
      const body = world.createRigidBody(desc);
      this.bodies.set(l.id, body);
      const mp = props.get(l.id);
      const kg = Math.max(1e-4, (mp?.massG ?? 0) / 1000);
      const shape = l.shape;
      let cd: RAPIER_T.ColliderDesc | null = null;
      if ('box' in shape) cd = lib.ColliderDesc.cuboid((shape.box[0] / 2) * MM, (shape.box[1] / 2) * MM, (shape.box[2] / 2) * MM);
      else if ('cylinder' in shape) cd = lib.ColliderDesc.cylinder((shape.cylinder.h / 2) * MM, shape.cylinder.r * MM);
      else if ('capsule' in shape) cd = lib.ColliderDesc.capsule((shape.capsule.h / 2) * MM, shape.capsule.r * MM);
      else if ('sphere' in shape) cd = lib.ColliderDesc.ball(shape.sphere * MM);
      if (cd) {
        const [x, y, z] = l.position ?? [0, 0, 0];
        const rq = new Quaternion().setFromEuler(new Euler(...((l.rotation ?? [0, 0, 0]).map((a) => a * DEG) as [number, number, number])));
        // the primitive's own inertia with the part's real mass (holes and pockets change the mass, not the shape here)
        world.createCollider(cd.setTranslation(x * MM, y * MM, z * MM).setRotation(rq).setMass(kg).setCollisionGroups(GROUP_MECH), body);
      } else if (l.id !== rootId) {
        body.setAdditionalMass(kg, true); // imported mesh: mass without a collider
      }
    }
    // mounted parts: boxes with their real masses (SG90 case, NEMA 17 body, A4988 board)
    const boxes: Record<string, Vec3> = { servo: [SPEC.sg90.lengthMm, SPEC.sg90.heightMm, SPEC.sg90.widthMm], stepper: [SPEC.nema17.frameMm, SPEC.nema17.frameMm, SPEC.nema17.bodyMm], a4988: [SPEC.a4988.boardMm[0], 1.6, SPEC.a4988.boardMm[1]] };
    for (const mt of asm.mounts ?? []) {
      const mm = MOUNT_MASS[mt.kind];
      const size = boxes[mt.kind];
      const body = this.bodies.get(mt.link);
      if (!mm || !size || !body) continue;
      const pose = new Matrix4().compose(new Vector3(...mt.position), new Quaternion().setFromEuler(new Euler(...((mt.rotation ?? [0, 0, 0]).map((a) => a * DEG) as [number, number, number]))), new Vector3(1, 1, 1));
      const c = new Vector3(...mm.com).applyMatrix4(pose);
      const q = new Quaternion().setFromRotationMatrix(pose);
      const cd = lib.ColliderDesc.cuboid((size[0] / 2) * MM, (size[1] / 2) * MM, (size[2] / 2) * MM)
        .setTranslation(c.x * MM, c.y * MM, c.z * MM)
        .setRotation(q)
        .setMass(mm.g / 1000)
        .setCollisionGroups(GROUP_MECH);
      world.createCollider(cd, body);
    }

    for (const j of asm.joints) {
      const parent = this.bodies.get(j.parent)!;
      const child = this.bodies.get(j.child)!;
      const frameQ = new Quaternion().setFromEuler(new Euler(...((j.rotation ?? [0, 0, 0]).map((a) => a * DEG) as [number, number, number])));
      const axis = new Vector3(...(j.axis ?? [0, 0, 1])).normalize();
      const anchor1 = { x: j.position[0] * MM, y: j.position[1] * MM, z: j.position[2] * MM };
      let rj: RAPIER_T.RevoluteImpulseJoint | null = null;
      if (j.type === 'revolute') {
        // child frame = joint frame × rotation about the axis, so the axis is the same vector in the child frame
        const a1 = axis.clone().applyQuaternion(frameQ);
        const data = lib.JointData.revoluteWithAxes(anchor1, { x: 0, y: 0, z: 0 }, a1, axis);
        rj = world.createImpulseJoint(data, parent, child, true) as RAPIER_T.RevoluteImpulseJoint;
        // force-based: the motor's max force is a real torque limit in N·m (the acceleration-based model limits acceleration instead)
        rj.configureMotorModel(lib.MotorModel.ForceBased);
      } else {
        // fixed (and, for now, prismatic) joints lock the child where it is
        const rel = new Quaternion().copy(parent.rotation() as Quaternion).invert().multiply(child.rotation() as Quaternion);
        const data = lib.JointData.fixed(anchor1, rel, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });
        world.createImpulseJoint(data, parent, child, true);
      }
      const rt: JointRt = { joint: j, rj, parent, child, frameQ, axis };
      if (rj && j.drive && 'device' in j.drive) {
        const mount = asm.mounts?.find((m) => m.device === (j.drive as { device: string }).device);
        const [f0, f1] = j.drive.from ?? [0, 180];
        const [t0, t1] = j.drive.to ?? j.drive.from ?? [0, 180];
        const ratio = (t1 - t0) / (f1 - f0);
        const servo = mount?.kind !== 'stepper';
        const deviceTorque = (servo ? SPEC.sg90.stallTorqueKgfCm : SPEC.nema17.holdingTorqueKgfCm) * KGFCM;
        const deviceSpeed = servo ? 60 / SPEC.sg90.secPer60Deg : SPEC.nema17.maxStepsPerSecApprox * (360 / SPEC.nema17.stepsPerRev);
        rt.drive = { device: j.drive.device, f0, t0, ratio, maxVel: Math.abs(ratio) * deviceSpeed * DEG, maxTorque: deviceTorque / Math.max(1e-6, Math.abs(ratio)) };
      }
      this.joints.push(rt);
    }
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
      this.world.step();
    }
  }

  private drive(deviceAngle: (device: string) => number | undefined): void {
    const angles = new Map<string, number>();
    for (const rt of this.joints) if (rt.rj) angles.set(rt.joint.id, this.angle(rt));
    const byId = new Map(this.joints.map((rt) => [rt.joint.id, rt]));
    for (const rt of this.joints) {
      const rj = rt.rj;
      if (!rj) continue;
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
      // hard stops: an undriven joint pushed past its limits is held back strongly
      if (j.limits && (now < j.limits[0] || now > j.limits[1])) {
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

  /** World poses of every link (mm). */
  poses(): Map<string, Pose> {
    const out = new Map<string, Pose>();
    for (const [id, b] of this.bodies) {
      const t = b.translation();
      const r = b.rotation();
      out.set(id, { p: [t.x / MM, t.y / MM, t.z / MM], q: [r.x, r.y, r.z, r.w] });
    }
    return out;
  }

  jointAngles(): Map<string, number> {
    const out = new Map<string, number>();
    for (const rt of this.joints) if (rt.rj) out.set(rt.joint.id, this.angle(rt));
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
    this.world.free();
  }
}

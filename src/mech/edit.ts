// Pure edits on an assembly, used by the 3D lab. Each returns a new assembly; the validator still has the
// last word.
import type { DeviceKind } from '../lab/devices';
import type { Assembly, Feature, Joint, Link, Mount, Shape, Vec3 } from './assembly';

export function newAssembly(name: string): Assembly {
  return {
    format: 'orrery.assembly',
    version: 1,
    name,
    units: 'mm',
    placement: [150, 0, 0],
    links: [{ id: 'base', label: 'base plate', shape: { box: [80, 5, 80] }, position: [0, 2.5, 0], material: 'PLA', make: 'print' }],
    joints: [],
  };
}

export function uniqueId(asm: Assembly, prefix: string): string {
  const used = new Set([...asm.links.map((l) => l.id), ...asm.joints.map((j) => j.id)]);
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

export const SHAPES: Record<string, Exclude<Shape, { mesh: unknown }>> = {
  box: { box: [30, 5, 30] },
  cylinder: { cylinder: { r: 10, h: 20 } },
  capsule: { capsule: { r: 6, h: 30 } },
  sphere: { sphere: 10 },
};

export function rootLink(asm: Assembly): Link {
  return asm.links.find((l) => !asm.joints.some((j) => j.child === l.id)) ?? asm.links[0];
}

export function parentJoint(asm: Assembly, linkId: string): Joint | undefined {
  return asm.joints.find((j) => j.child === linkId);
}

/** Add a printed part on top of `parentId`, held by a fixed joint (change it to revolute or prismatic later). */
export function addChild(asm: Assembly, parentId: string, shape: keyof typeof SHAPES): { asm: Assembly; id: string } {
  const id = uniqueId(asm, 'part');
  const link: Link = { id, label: `${shape} part`, shape: structuredClone(SHAPES[shape]), material: 'PLA', make: 'print' };
  const joint: Joint = { id: `${id}_joint`, type: 'fixed', parent: parentId, child: id, position: [0, 20, 0] };
  return { asm: { ...asm, links: [...asm.links, link], joints: [...asm.joints, joint] }, id };
}

/** Remove a link with everything attached below it, and the drives and mounts that referred to them. */
export function removeLink(asm: Assembly, id: string): Assembly {
  if (rootLink(asm).id === id) return asm;
  const gone = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const j of asm.joints) if (gone.has(j.parent) && !gone.has(j.child)) (gone.add(j.child), (grew = true));
  }
  const joints = asm.joints.filter((j) => !gone.has(j.child));
  const jointIds = new Set(joints.map((j) => j.id));
  return {
    ...asm,
    links: asm.links.filter((l) => !gone.has(l.id)),
    joints: joints.map((j) => (j.drive && 'follow' in j.drive && !jointIds.has(j.drive.follow) ? { ...j, drive: undefined } : j)),
    mounts: (asm.mounts ?? []).filter((m) => !gone.has(m.link)),
  };
}

export function patchLink(asm: Assembly, id: string, patch: Partial<Link>): Assembly {
  return { ...asm, links: asm.links.map((l) => (l.id === id ? { ...l, ...patch } : l)) };
}

export function patchJoint(asm: Assembly, id: string, patch: Partial<Joint>): Assembly {
  return { ...asm, joints: asm.joints.map((j) => (j.id === id ? { ...j, ...patch } : j)) };
}

export function setFeatures(asm: Assembly, linkId: string, features: Feature[]): Assembly {
  return patchLink(asm, linkId, { features: features.length ? features : undefined });
}

/** Mount a bench device on a link (moving it if it was mounted elsewhere). */
export function mountDevice(asm: Assembly, device: string, kind: DeviceKind, link: string, position: Vec3 = [0, 0, 0]): Assembly {
  const mounts: Mount[] = [...(asm.mounts ?? []).filter((m) => m.device !== device), { device, kind, link, position }];
  return { ...asm, mounts };
}

export function unmount(asm: Assembly, device: string): Assembly {
  const mounts = (asm.mounts ?? []).filter((m) => m.device !== device);
  return {
    ...asm,
    mounts,
    joints: asm.joints.map((j) => (j.drive && 'device' in j.drive && j.drive.device === device ? { ...j, drive: undefined } : j)),
  };
}

/** Make the joint above `linkId` a revolute joint driven by `device`, mounting the device on the parent link if needed. */
export function driveWith(asm: Assembly, jointId: string, device: string, kind: DeviceKind): Assembly {
  const j = asm.joints.find((x) => x.id === jointId);
  if (!j) return asm;
  let next = asm;
  if (!(asm.mounts ?? []).some((m) => m.device === device)) next = mountDevice(next, device, kind, j.parent);
  const range: [number, number] = kind === 'servo' ? [0, 180] : [0, 360];
  return patchJoint(next, jointId, {
    type: j.type === 'fixed' ? 'revolute' : j.type,
    axis: j.axis ?? [0, 1, 0],
    drive: { device, from: range, to: kind === 'servo' ? [-90, 90] : range },
    limits: j.limits ?? (kind === 'servo' ? [-90, 90] : undefined),
  });
}

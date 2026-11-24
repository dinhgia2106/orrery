// The 3D lab: build the mechanism part by part — shapes in mm, joints, drives from the bench, holes and
// pockets that fit real parts — and export STL, drawings and a fabrication package to make it for real.
import { useState, type ReactNode } from 'react';
import type { Device } from '../lab/project';
import { validateAssembly, type Assembly, type Feature, type Joint, type Link, type PocketFor, type Vec3 } from './assembly';
import { addChild, driveWith, mountDevice, newAssembly, parentJoint, patchJoint, patchLink, removeLink, rootLink, setFeatures, SHAPES, unmount } from './edit';
import { fabricationPackage, madeHere, partStl, partSvg } from './fabricate';
import type { Project } from '../lab/project';
import { CLEARANCE_HOLE_MM, DEFAULT_CLEARANCE_MM } from './solid';

interface Props {
  project: Project;
  onAssembly: (asm: Assembly | undefined) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  download: (name: string, data: BlobPart, type: string) => void;
}

const MATERIALS: NonNullable<Link['material']>[] = ['PLA', 'PETG', 'TPU', 'ABS', 'resin', 'aluminium', 'steel', 'acrylic', 'wood', 'other'];
const MAKES: NonNullable<Link['make']>[] = ['print', 'buy', 'cut', 'machine'];
const POCKETS: { v: PocketFor; label: string }[] = [
  { v: 'sg90', label: 'SG90 servo body' },
  { v: 'nema17', label: 'NEMA 17 face (φ22 + 4×M3)' },
  { v: 'a4988', label: 'A4988 carrier' },
  { v: 'b3f', label: 'B3F 6×6 switch' },
];

function Num({ label, value, onChange, step = 0.5, min }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number }) {
  return (
    <label className="num">
      <span>{label}</span>
      <input type="number" step={step} min={min} value={Number.isFinite(value) ? value : 0} onChange={(e) => e.target.value !== '' && onChange(Number(e.target.value))} />
    </label>
  );
}

function Vec({ label, value, onChange, step }: { label: string; value: Vec3 | undefined; onChange: (v: Vec3) => void; step?: number }) {
  const v = value ?? [0, 0, 0];
  return (
    <div className="vec">
      <span className="vec-label mono">{label}</span>
      {(['x', 'y', 'z'] as const).map((k, i) => (
        <Num key={k} label={k} value={v[i]} step={step} onChange={(n) => onChange(v.map((x, j) => (j === i ? n : x)) as Vec3)} />
      ))}
    </div>
  );
}

function Block({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="lab-block">
      <div className="lab-block-head mono">
        <span>{title}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

export default function LabPanel({ project, onAssembly, selected, onSelect, download }: Props) {
  const asm = project.assembly;
  const [busy, setBusy] = useState('');
  if (!asm)
    return (
      <div className="lab-panel">
        <div className="lab-title mono">3D LAB</div>
        <p className="small muted">Build the mechanism here: parts in millimetres, joints driven by your bench servos and steppers, holes and pockets that fit the real parts — then export STL and drawings to make it.</p>
        <button className="primary wide" onClick={() => (onAssembly(newAssembly(project.name)), onSelect('base'))}>
          Start a mechanism
        </button>
      </div>
    );

  const check = validateAssembly(asm);
  const link = asm.links.find((l) => l.id === selected) ?? null;
  const joint = link ? parentJoint(asm, link.id) : undefined;
  const set = (next: Assembly) => onAssembly(next);
  const actuators = project.devices.filter((d) => d.kind === 'servo' || d.kind === 'stepper');
  const mountable = project.devices.filter((d) => d.kind !== 'uno' && d.kind !== 'psu');

  const children = (id: string, depth: number): ReactNode[] =>
    asm.joints
      .filter((j) => j.parent === id)
      .flatMap((j) => [
        <TreeRow key={j.child} l={asm.links.find((l) => l.id === j.child)!} depth={depth} j={j} selected={selected} onSelect={onSelect} />,
        ...children(j.child, depth + 1),
      ]);
  const root = rootLink(asm);

  const run = async (label: string, f: () => Promise<void>) => {
    setBusy(label);
    try {
      await f();
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="lab-panel">
      <div className="lab-title mono">
        3D LAB · <input className="lab-name" value={asm.name} onChange={(e) => set({ ...asm, name: e.target.value })} />
      </div>
      <Block title="PARTS" right={<span className="muted">{asm.links.length}</span>}>
        <ul className="tree">
          <TreeRow l={root} depth={0} selected={selected} onSelect={onSelect} />
          {children(root.id, 1)}
        </ul>
        <div className="lab-row">
          {(Object.keys(SHAPES) as (keyof typeof SHAPES)[]).map((k) => (
            <button key={k} onClick={() => { const r = addChild(asm, link?.id ?? root.id, k); set(r.asm); onSelect(r.id); }}>
              + {k}
            </button>
          ))}
        </div>
      </Block>

      {link && (
        <>
          <Block
            title={`PART · ${link.id}`}
            right={link.id !== root.id ? <button className="link-danger" onClick={() => (set(removeLink(asm, link.id)), onSelect(null))}>remove</button> : undefined}
          >
            <input className="lab-text" value={link.label ?? ''} placeholder="what it is" onChange={(e) => set(patchLink(asm, link.id, { label: e.target.value }))} />
            <ShapeEditor link={link} onChange={(shape) => set(patchLink(asm, link.id, { shape }))} />
            <Vec label="offset" value={link.position} onChange={(position) => set(patchLink(asm, link.id, { position }))} />
            <Vec label="rot °" value={link.rotation} step={5} onChange={(rotation) => set(patchLink(asm, link.id, { rotation }))} />
            <div className="lab-row">
              <select value={link.make ?? 'print'} onChange={(e) => set(patchLink(asm, link.id, { make: e.target.value as Link['make'] }))}>
                {MAKES.map((m) => <option key={m}>{m}</option>)}
              </select>
              <select value={link.material ?? 'PLA'} onChange={(e) => set(patchLink(asm, link.id, { material: e.target.value as Link['material'] }))}>
                {MATERIALS.map((m) => <option key={m}>{m}</option>)}
              </select>
              <input type="color" value={link.color ?? '#d9dee6'} onChange={(e) => set(patchLink(asm, link.id, { color: e.target.value }))} />
              <Num label="opacity" value={link.opacity ?? 1} step={0.1} min={0} onChange={(o) => set(patchLink(asm, link.id, { opacity: Math.min(1, Math.max(0.05, o)) }))} />
            </div>
          </Block>

          {joint && (
            <Block title={`JOINT · ${joint.id}`}>
              <div className="lab-row">
                <select value={joint.type} onChange={(e) => set(patchJoint(asm, joint.id, { type: e.target.value as Joint['type'], axis: joint.axis ?? [0, 1, 0] }))}>
                  <option value="fixed">fixed</option>
                  <option value="revolute">revolute (°)</option>
                  <option value="prismatic">prismatic (mm)</option>
                </select>
                {joint.type !== 'fixed' && (
                  <select value={axisName(joint.axis)} onChange={(e) => set(patchJoint(asm, joint.id, { axis: AXES[e.target.value] }))}>
                    {Object.keys(AXES).map((a) => <option key={a}>{a}</option>)}
                  </select>
                )}
              </div>
              <Vec label="at" value={joint.position} onChange={(position) => set(patchJoint(asm, joint.id, { position }))} />
              <Vec label="rot °" value={joint.rotation} step={5} onChange={(rotation) => set(patchJoint(asm, joint.id, { rotation }))} />
              {joint.type !== 'fixed' && (
                <>
                  <div className="lab-row">
                    <Num label="min" value={joint.limits?.[0] ?? -90} onChange={(v) => set(patchJoint(asm, joint.id, { limits: [v, joint.limits?.[1] ?? 90] }))} />
                    <Num label="max" value={joint.limits?.[1] ?? 90} onChange={(v) => set(patchJoint(asm, joint.id, { limits: [joint.limits?.[0] ?? -90, v] }))} />
                    <button onClick={() => set(patchJoint(asm, joint.id, { limits: undefined }))}>free</button>
                  </div>
                  <DriveEditor asm={asm} joint={joint} actuators={actuators} onChange={set} />
                </>
              )}
            </Block>
          )}

          <Block title="FEATURES (holes, pockets, cuts, bosses)">
            <FeatureEditor features={link.features ?? []} onChange={(f) => set(setFeatures(asm, link.id, f))} disabled={'mesh' in link.shape} />
          </Block>

          <Block title="MOUNTED HERE">
            {(asm.mounts ?? []).filter((m) => m.link === link.id).map((m) => (
              <div key={m.device} className="mount-row">
                <span className="ref mono">{m.device}</span>
                <Vec label="at" value={m.position} onChange={(position) => set({ ...asm, mounts: asm.mounts!.map((x) => (x.device === m.device ? { ...x, position } : x)) })} />
                <Vec label="rot °" value={m.rotation} step={15} onChange={(rotation) => set({ ...asm, mounts: asm.mounts!.map((x) => (x.device === m.device ? { ...x, rotation } : x)) })} />
                <button className="link-danger" onClick={() => set(unmount(asm, m.device))}>unmount</button>
              </div>
            ))}
            <MountPicker devices={mountable} onPick={(d) => set(mountDevice(asm, d.id, d.kind, link.id))} />
          </Block>

          {madeHere(link) && (
            <div className="lab-row">
              <button disabled={!!busy} onClick={() => run('stl', async () => { const stl = await partStl(link); if (stl) download(`${link.id}.stl`, stl, 'model/stl'); })}>
                {busy === 'stl' ? '…' : 'STL'}
              </button>
              <button disabled={!!busy || 'mesh' in link.shape} onClick={() => run('svg', async () => { const svg = await partSvg(link, asm); if (svg) download(`${link.id}-drawing.svg`, svg, 'image/svg+xml'); })}>
                {busy === 'svg' ? '…' : 'Drawing'}
              </button>
            </div>
          )}
        </>
      )}

      <Block title="MAKE IT">
        {!check.ok && (
          <ul className="asm-errors mono small">
            {check.errors.slice(0, 6).map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
        <button className="primary wide" disabled={!!busy || !check.ok} onClick={() => run('zip', async () => download(`${asm.name.replace(/[^\w-]+/g, '_')}-fabrication.zip`, await fabricationPackage(project), 'application/zip'))}>
          {busy === 'zip' ? 'Building…' : `Fabrication package (${asm.links.filter(madeHere).length} parts: STL + drawings + BOM)`}
        </button>
        <p className="small muted">Pocket clearance defaults to {DEFAULT_CLEARANCE_MM} mm per side — a printing allowance, not a datasheet value. Holes: M3 {CLEARANCE_HOLE_MM.M3} mm, M2 {CLEARANCE_HOLE_MM.M2} mm (ISO 273 medium).</p>
      </Block>
    </div>
  );
}

const AXES: Record<string, Vec3> = { 'X axis': [1, 0, 0], 'Y axis': [0, 1, 0], 'Z axis': [0, 0, 1] };
function axisName(a?: Vec3): string {
  const v = a ?? [0, 1, 0];
  return Object.entries(AXES).find(([, x]) => x.every((c, i) => c === v[i]))?.[0] ?? 'Y axis';
}

function TreeRow({ l, depth, j, selected, onSelect }: { l: Link; depth: number; j?: Joint; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <li className={selected === l.id ? 'on' : ''} style={{ paddingLeft: 6 + depth * 12 }} onClick={() => onSelect(l.id)}>
      <span className="mono">{l.id}</span> <span className="muted small">{l.label}</span>
      {j && j.type !== 'fixed' && <span className="joint-tag mono">{j.type === 'revolute' ? '↻' : '↕'}{j.drive ? ('device' in j.drive ? ` ${j.drive.device}` : ` ← ${j.drive.follow}`) : ''}</span>}
    </li>
  );
}

function ShapeEditor({ link, onChange }: { link: Link; onChange: (s: Link['shape']) => void }) {
  const s = link.shape;
  if ('mesh' in s) return <p className="small muted">Imported STL mesh{s.mesh.scale ? ` × ${s.mesh.scale}` : ''}.</p>;
  const kind = Object.keys(s)[0] as keyof typeof SHAPES;
  return (
    <div className="lab-row">
      <select value={kind} onChange={(e) => onChange(structuredClone(SHAPES[e.target.value]))}>
        {Object.keys(SHAPES).map((k) => <option key={k}>{k}</option>)}
      </select>
      {'box' in s && (['x', 'y', 'z'] as const).map((k, i) => <Num key={k} label={k} min={0.1} value={s.box[i]} onChange={(v) => onChange({ box: s.box.map((x, j) => (j === i ? Math.max(0.1, v) : x)) as Vec3 })} />)}
      {'cylinder' in s && (<><Num label="r" min={0.1} value={s.cylinder.r} onChange={(r) => onChange({ cylinder: { ...s.cylinder, r: Math.max(0.1, r) } })} /><Num label="h" min={0.1} value={s.cylinder.h} onChange={(h) => onChange({ cylinder: { ...s.cylinder, h: Math.max(0.1, h) } })} /></>)}
      {'capsule' in s && (<><Num label="r" min={0.1} value={s.capsule.r} onChange={(r) => onChange({ capsule: { ...s.capsule, r: Math.max(0.1, r) } })} /><Num label="h" min={0.1} value={s.capsule.h} onChange={(h) => onChange({ capsule: { ...s.capsule, h: Math.max(0.1, h) } })} /></>)}
      {'sphere' in s && <Num label="r" min={0.1} value={s.sphere} onChange={(r) => onChange({ sphere: Math.max(0.1, r) })} />}
      <span className="muted small">mm</span>
    </div>
  );
}

function DriveEditor({ asm, joint, actuators, onChange }: { asm: Assembly; joint: Joint; actuators: Device[]; onChange: (a: Assembly) => void }) {
  const d = joint.drive;
  const mode = !d ? 'none' : 'device' in d ? `dev:${d.device}` : `follow:${d.follow}`;
  return (
    <div className="lab-row">
      <select
        value={mode}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'none') onChange(patchJoint(asm, joint.id, { drive: undefined }));
          else if (v.startsWith('dev:')) {
            const dev = actuators.find((a) => a.id === v.slice(4))!;
            onChange(driveWith(asm, joint.id, dev.id, dev.kind));
          } else onChange(patchJoint(asm, joint.id, { drive: { follow: v.slice(7), ratio: 1 } }));
        }}
      >
        <option value="none">not driven</option>
        {actuators.map((a) => <option key={a.id} value={`dev:${a.id}`}>driven by {a.id}</option>)}
        {asm.joints.filter((j) => j.id !== joint.id && j.type !== 'fixed').map((j) => <option key={j.id} value={`follow:${j.id}`}>follows {j.id}</option>)}
      </select>
      {d && 'device' in d && (
        <>
          <Num label="to min" value={d.to?.[0] ?? 0} onChange={(v) => onChange(patchJoint(asm, joint.id, { drive: { ...d, to: [v, d.to?.[1] ?? 180] } }))} />
          <Num label="to max" value={d.to?.[1] ?? 180} onChange={(v) => onChange(patchJoint(asm, joint.id, { drive: { ...d, to: [d.to?.[0] ?? 0, v] } }))} />
        </>
      )}
      {d && 'follow' in d && <Num label="ratio" step={0.05} value={d.ratio ?? 1} onChange={(ratio) => onChange(patchJoint(asm, joint.id, { drive: { ...d, ratio } }))} />}
      {actuators.length === 0 && <span className="small muted">add a servo or stepper to the bench to drive joints</span>}
    </div>
  );
}

function FeatureEditor({ features, onChange, disabled }: { features: Feature[]; onChange: (f: Feature[]) => void; disabled: boolean }) {
  if (disabled) return <p className="small muted">Features apply to primitive shapes.</p>;
  const put = (i: number, f: Feature) => onChange(features.map((x, k) => (k === i ? f : x)));
  return (
    <>
      {features.map((f, i) => (
        <div key={i} className="feature">
          <div className="lab-row">
            <b className="mono small">{Object.keys(f)[0]}</b>
            {'hole' in f && (
              <>
                <Num label="Ø" min={0.1} step={0.1} value={f.hole.d} onChange={(d) => put(i, { hole: { ...f.hole, d } })} />
                <select value={f.hole.axis ?? 'y'} onChange={(e) => put(i, { hole: { ...f.hole, axis: e.target.value as 'x' | 'y' | 'z' } })}>
                  <option value="x">along X</option>
                  <option value="y">along Y</option>
                  <option value="z">along Z</option>
                </select>
              </>
            )}
            {'pocket' in f && (
              <>
                <select value={f.pocket.for} onChange={(e) => put(i, { pocket: { ...f.pocket, for: e.target.value as PocketFor } })}>
                  {POCKETS.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
                </select>
                <Num label="clear" step={0.05} min={0} value={f.pocket.clearance ?? DEFAULT_CLEARANCE_MM} onChange={(clearance) => put(i, { pocket: { ...f.pocket, clearance } })} />
              </>
            )}
            <button className="link-danger" onClick={() => onChange(features.filter((_, k) => k !== i))}>×</button>
          </div>
          {'hole' in f && <Vec label="at" value={f.hole.position} onChange={(position) => put(i, { hole: { ...f.hole, position } })} />}
          {'pocket' in f && <Vec label="at" value={f.pocket.position} onChange={(position) => put(i, { pocket: { ...f.pocket, position } })} />}
          {'pocket' in f && <Vec label="rot °" step={15} value={f.pocket.rotation} onChange={(rotation) => put(i, { pocket: { ...f.pocket, rotation } })} />}
          {'cut' in f && <Vec label="size" value={f.cut.box} onChange={(box) => put(i, { cut: { ...f.cut, box: box.map((x) => Math.max(0.1, x)) as Vec3 } })} />}
          {'cut' in f && <Vec label="at" value={f.cut.position} onChange={(position) => put(i, { cut: { ...f.cut, position } })} />}
          {'add' in f && 'cylinder' in f.add.shape && (
            <div className="lab-row">
              <Num label="r" min={0.1} value={f.add.shape.cylinder.r} onChange={(r) => put(i, { add: { ...f.add, shape: { cylinder: { ...(f.add.shape as { cylinder: { r: number; h: number } }).cylinder, r } } } })} />
              <Num label="h" min={0.1} value={f.add.shape.cylinder.h} onChange={(h) => put(i, { add: { ...f.add, shape: { cylinder: { ...(f.add.shape as { cylinder: { r: number; h: number } }).cylinder, h } } } })} />
            </div>
          )}
          {'add' in f && <Vec label="at" value={f.add.position} onChange={(position) => put(i, { add: { ...f.add, position } })} />}
        </div>
      ))}
      <div className="lab-row">
        <button onClick={() => onChange([...features, { hole: { d: CLEARANCE_HOLE_MM.M3, position: [0, 0, 0] } }])}>+ M3 hole</button>
        <button onClick={() => onChange([...features, { pocket: { for: 'sg90', position: [0, 0, 0] } }])}>+ pocket</button>
        <button onClick={() => onChange([...features, { cut: { box: [10, 10, 10], position: [0, 0, 0] } }])}>+ cut</button>
        <button onClick={() => onChange([...features, { add: { shape: { cylinder: { r: 4, h: 6 } }, position: [0, 6, 0] } }])}>+ boss</button>
      </div>
    </>
  );
}

function MountPicker({ devices, onPick }: { devices: Device[]; onPick: (d: Device) => void }) {
  if (!devices.length) return <p className="small muted">Bench devices (servos, steppers, drivers, buttons…) can be mounted on a part.</p>;
  return (
    <select value="" onChange={(e) => { const d = devices.find((x) => x.id === e.target.value); if (d) onPick(d); }}>
      <option value="">mount a bench device here…</option>
      {devices.map((d) => <option key={d.id} value={d.id}>{d.id} ({d.kind})</option>)}
    </select>
  );
}

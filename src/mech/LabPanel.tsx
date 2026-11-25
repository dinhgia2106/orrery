// The 3D lab panels: parts tree, selected part/joint/feature/mount inspector, physics & dynamics, and
// fabrication/3D print exports — split into focused panels for the left and right workbench sidebars.
import { useState, type ReactNode } from 'react';
import type { Device, Project } from '../lab/project';
import { validateAssembly, type Assembly, type Feature, type Joint, type Link, type PocketFor, type Vec3 } from './assembly';
import { addChild, driveWith, mountDevice, newAssembly, parentJoint, patchJoint, patchLink, removeLink, rootLink, setFeatures, SHAPES, unmount } from './edit';
import { fabricationPackage, madeHere, partStl, partSvg } from './fabricate';
import { DENSITY, type ActuatorLoad, type Clash, type MassProps } from './physics';
import { CLEARANCE_HOLE_MM, DEFAULT_CLEARANCE_MM } from './solid';
import type { TendonReading } from './tendon';
import PrintPanel from './PrintPanel';

export interface PhysicsView {
  dynamics: {
    on: boolean;
    ready: boolean;
    setOn: (on: boolean) => void;
    reset: () => void;
    drop: (kind: 'ball' | 'box') => void;
    tracking: () => { device: string; commanded: number; actual: number }[];
    /** Pairs of parts touching right now, and how many pairs were left out because they overlap at rest. */
    touching: () => { a: string; b: string }[];
    restOverlaps: () => number;
  };
  /** Every tendon's tension and slack right now. */
  tendons: () => TendonReading[];
  massProps: Map<string, MassProps> | null;
  actuators: ActuatorLoad[];
  totalMassG: number | null;
  clashes: Clash[] | null;
  checking: boolean;
  onCheck: () => void;
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

function CollapsibleBlock({ title, right, defaultOpen = true, children }: { title: string; right?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="lab-block">
      <div className="lab-block-head mono">
        <button type="button" className="lab-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span>{title}</span>
        </button>
        {right && <span className="lab-block-right">{right}</span>}
      </div>
      {open && children}
    </div>
  );
}

/** Left sidebar view when in 3D Lab: assembly tree, add-primitive row, and import/export actions. */
export function LabPartsPanel({
  project,
  onAssembly,
  selected,
  onSelect,
  download,
  onImportFile,
  onOpenAi,
}: {
  project: Project;
  onAssembly: (asm: Assembly | undefined) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  download: (name: string, data: BlobPart, type: string) => void;
  onImportFile: (file: File) => void;
  onOpenAi: () => void;
}) {
  const asm = project.assembly;
  if (!asm) {
    return (
      <div className="lab-stack">
        <p className="small muted">Build parts in mm, drive joints from the bench, or import an assembly / STL.</p>
        <button className="primary wide" onClick={() => (onAssembly(newAssembly(project.name)), onSelect('base'))}>
          Start a mechanism
        </button>
        <div className="file-row">
          <label className="file-btn">
            Import
            <input type="file" accept=".json,.stl" onChange={(e) => e.target.files?.[0] && onImportFile(e.target.files[0])} />
          </label>
          <button onClick={onOpenAi}>AI / paste</button>
        </div>
      </div>
    );
  }

  const root = rootLink(asm);
  const link = asm.links.find((l) => l.id === selected) ?? null;
  const missingMounts = (asm.mounts ?? []).filter((m) => !project.devices.some((d) => d.id === m.device));
  const children = (id: string, depth: number): ReactNode[] =>
    asm.joints
      .filter((j) => j.parent === id)
      .flatMap((j) => [
        <TreeRow key={j.child} l={asm.links.find((l) => l.id === j.child)!} depth={depth} j={j} selected={selected} onSelect={onSelect} />,
        ...children(j.child, depth + 1),
      ]);

  return (
    <div className="lab-stack">
      <div className="lab-title mono">
        <span>MECH</span>
        <input className="lab-name" value={asm.name} onChange={(e) => onAssembly({ ...asm, name: e.target.value })} aria-label="Mechanism name" />
      </div>
      <div className="lab-block">
        <div className="lab-block-head mono">
          <span>PARTS</span>
          <span className="muted">{asm.links.length}</span>
        </div>
        <ul className="tree tree-tall">
          <TreeRow l={root} depth={0} selected={selected} onSelect={onSelect} />
          {children(root.id, 1)}
        </ul>
        <div className="lab-row">
          {(Object.keys(SHAPES) as (keyof typeof SHAPES)[]).map((k) => (
            <button key={k} onClick={() => { const r = addChild(asm, link?.id ?? root.id, k); onAssembly(r.asm); onSelect(r.id); }}>
              + {k}
            </button>
          ))}
        </div>
      </div>
      {missingMounts.length > 0 && <p className="small warn-text">Missing on the bench: {missingMounts.map((m) => m.device).join(', ')}</p>}
      <div className="file-row">
        <label className="file-btn">
          Import
          <input type="file" accept=".json,.stl" onChange={(e) => e.target.files?.[0] && onImportFile(e.target.files[0])} />
        </label>
        <button onClick={onOpenAi}>AI / paste</button>
        <button onClick={() => download(`${asm.name.replace(/[^\w-]+/g, '_')}.assembly.json`, JSON.stringify(asm, null, 2), 'application/json')}>Export</button>
        <button onClick={() => { onAssembly(undefined); onSelect(null); }}>Remove</button>
      </div>
    </div>
  );
}

/** Right sidebar Inspect tab when in 3D Lab: edit selected link, joint, features, and mounted devices. */
export function LabPartInspector({
  project,
  onAssembly,
  selected,
  onSelect,
  download,
  massProps,
  totalMassG,
}: {
  project: Project;
  onAssembly: (asm: Assembly | undefined) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  download: (name: string, data: BlobPart, type: string) => void;
  massProps: Map<string, MassProps> | null;
  totalMassG: number | null;
}) {
  const [busy, setBusy] = useState('');
  const asm = project.assembly;
  if (!asm) return <p className="muted small">No mechanism on the bench yet.</p>;

  const link = asm.links.find((l) => l.id === selected) ?? null;
  if (!link) {
    return (
      <div className="lab-stack">
        <div className="card mech">
          <strong>{asm.name}</strong>
          <span className="mono muted small">
            {asm.links.length} links · {asm.joints.length} joints · {(asm.mounts ?? []).length} mounted
            {totalMassG !== null ? ` · ${totalMassG.toFixed(0)} g` : ''}
          </span>
        </div>
        <p className="muted small">Click any part in 3D or the Parts tree to edit its shape, joint, features, or mounts.</p>
      </div>
    );
  }

  const root = rootLink(asm);
  const joint = parentJoint(asm, link.id);
  const actuators = project.devices.filter((d) => d.kind === 'servo' || d.kind === 'stepper');
  const mountable = project.devices.filter((d) => d.kind !== 'uno' && d.kind !== 'psu');
  const mountedHere = (asm.mounts ?? []).filter((m) => m.link === link.id);
  const set = (next: Assembly) => onAssembly(next);

  const run = async (label: string, f: () => Promise<void>) => {
    setBusy(label);
    try {
      await f();
    } finally {
      setBusy('');
    }
  };

  return (
    <div key={link.id} className="lab-stack">
      <CollapsibleBlock
        title={`PART · ${link.id}`}
        defaultOpen
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
        <MassLine link={link} mp={massProps?.get(link.id)} onMass={(massG) => set(patchLink(asm, link.id, { massG }))} />
      </CollapsibleBlock>

      {joint && (
        <CollapsibleBlock title={`JOINT · ${joint.id}`} defaultOpen={joint.type !== 'fixed'} right={<span className="muted">{joint.type}</span>}>
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
        </CollapsibleBlock>
      )}

      <CollapsibleBlock title="FEATURES" defaultOpen={false} right={<span className="muted">{link.features?.length ?? 0}</span>}>
        <FeatureEditor features={link.features ?? []} onChange={(f) => set(setFeatures(asm, link.id, f))} disabled={'mesh' in link.shape} />
      </CollapsibleBlock>

      <CollapsibleBlock title="MOUNTED HERE" defaultOpen={false} right={<span className="muted">{mountedHere.length}</span>}>
        {mountedHere.map((m) => (
          <div key={m.device} className="mount-row">
            <span className="ref mono">{m.device}</span>
            <Vec label="at" value={m.position} onChange={(position) => set({ ...asm, mounts: asm.mounts!.map((x) => (x.device === m.device ? { ...x, position } : x)) })} />
            <Vec label="rot °" value={m.rotation} step={15} onChange={(rotation) => set({ ...asm, mounts: asm.mounts!.map((x) => (x.device === m.device ? { ...x, rotation } : x)) })} />
            <button className="link-danger" onClick={() => set(unmount(asm, m.device))}>unmount</button>
          </div>
        ))}
        <MountPicker devices={mountable} onPick={(d) => set(mountDevice(asm, d.id, d.kind, link.id))} />
      </CollapsibleBlock>

      {madeHere(link) && (
        <div className="lab-row">
          <button disabled={!!busy} onClick={() => run('stl', async () => { const stl = await partStl(link); if (stl) download(`${link.id}.stl`, stl, 'model/stl'); })}>
            {busy === 'stl' ? '…' : 'Export STL'}
          </button>
          <button disabled={!!busy || 'mesh' in link.shape} onClick={() => run('svg', async () => { const svg = await partSvg(link, asm); if (svg) download(`${link.id}-drawing.svg`, svg, 'image/svg+xml'); })}>
            {busy === 'svg' ? '…' : 'Export Drawing'}
          </button>
        </div>
      )}
    </div>
  );
}

/** Right sidebar Physics tab: gravity loads, collisions, tendons, and Rapier rigid-body dynamics. */
export function LabPhysicsPanel({ physics, asm, onSelect }: { physics: PhysicsView; asm: Assembly; onSelect: (id: string) => void }) {
  const [showAllLoads, setShowAllLoads] = useState(false);
  const unknown = physics.massProps ? [...physics.massProps.entries()].filter(([, m]) => m.how === 'unknown').map(([id]) => id) : [];
  const sorted = [...physics.actuators].sort((a, b) => Math.abs(b.torqueKgfCm) / b.limitKgfCm - Math.abs(a.torqueKgfCm) / a.limitKgfCm);
  const visibleLoads = showAllLoads ? sorted : sorted.slice(0, 6);
  const tendons = (asm.tendons?.length ?? 0) > 0 ? physics.tendons() : [];
  const slackCount = tendons.filter((t) => Math.abs(t.slackMm) > 1).length;
  const maxTension = tendons.reduce((m, t) => Math.max(m, t.tensionN), 0);

  return (
    <div className="lab-stack">
      <div className="lab-block">
        <div className="lab-block-head mono">
          <span>GRAVITY &amp; STATICS</span>
          <span className="muted">{physics.totalMassG !== null ? `${physics.totalMassG.toFixed(0)} g` : '…'}</span>
        </div>
        {unknown.length > 0 && <p className="small warn-text">No mass for {unknown.join(', ')} — set massG.</p>}
        {sorted.length > 0 ? (
          <>
            <table className="loads mono">
              <tbody>
                {visibleLoads.map((a) => {
                  const pct = Math.abs(a.torqueKgfCm) / a.limitKgfCm;
                  return (
                    <tr key={a.device} className={pct >= 1 ? 'over' : pct > 0.7 ? 'high' : ''} title="kgf·cm at the shaft vs SG90 stall (1.8) or NEMA 17 holding torque (3.7)">
                      <td>{a.device}</td>
                      <td>{(Math.abs(a.torqueKgfCm) < 0.005 ? 0 : a.torqueKgfCm).toFixed(2)}</td>
                      <td className="bar-cell">
                        <span className="load-bar" style={{ width: `${Math.min(100, pct * 100)}%` }} />
                      </td>
                      <td>{(pct * 100).toFixed(0)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {sorted.length > 6 && (
              <button type="button" className="link-btn small mono" onClick={() => setShowAllLoads((v) => !v)}>
                {showAllLoads ? 'Show top 6' : `Show all ${sorted.length}`}
              </button>
            )}
          </>
        ) : (
          <p className="small muted">Drive a joint with a bench servo or stepper to see its gravity load.</p>
        )}
        <div className="lab-row">
          <button onClick={physics.onCheck} disabled={physics.checking}>
            {physics.checking ? 'Checking…' : 'Check collisions'}
          </button>
          {physics.clashes && <span className={physics.clashes.length ? 'warn-text small' : 'small muted'}>{physics.clashes.length ? `${physics.clashes.length} clash(es)` : 'no clashes'}</span>}
        </div>
        {physics.clashes?.slice(0, 8).map((c) => (
          <div key={`${c.a}|${c.b}`} className="small clash" onClick={() => onSelect(c.a)}>
            <b className="mono">{c.a}</b> ↔ <b className="mono">{c.b}</b> — {c.volumeMm3.toFixed(0)} mm³
          </div>
        ))}
        {asm.joints.some((j) => j.type === 'prismatic' && j.drive) && <p className="small muted">Prismatic joints: slide forces not computed yet.</p>}
      </div>

      {tendons.length > 0 && (
        <CollapsibleBlock
          title={`TENDONS (${tendons.length})`}
          defaultOpen={false}
          right={<span className="muted">{slackCount ? `${slackCount} off` : `${maxTension.toFixed(1)} N max`}</span>}
        >
          <TendonsBlock all={tendons} />
        </CollapsibleBlock>
      )}

      <div className="lab-block">
        <DynamicsBlock d={physics.dynamics} />
      </div>
    </div>
  );
}

/** Right sidebar Make tab: assembly validation, fabrication ZIP, and 3D print planner. */
export function LabMakePanel({
  project,
  asm,
  download,
}: {
  project: Project;
  asm: Assembly;
  download: (name: string, data: BlobPart, type: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const check = validateAssembly(asm);
  return (
    <div className="lab-block">
      <div className="lab-block-head mono">
        <span>FABRICATION</span>
        <span className="muted">{asm.links.filter(madeHere).length} parts</span>
      </div>
      {!check.ok && (
        <ul className="asm-errors mono small">
          {check.errors.slice(0, 6).map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}
      <button
        className="primary wide"
        disabled={busy || !check.ok}
        onClick={async () => {
          setBusy(true);
          try {
            download(`${asm.name.replace(/[^\w-]+/g, '_')}-fabrication.zip`, await fabricationPackage(project), 'application/zip');
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Building…' : `Fabrication package (${asm.links.filter(madeHere).length} parts)`}
      </button>
      <PrintPanelLazy asm={asm} download={download} />
      <p className="small muted">Pocket clearance {DEFAULT_CLEARANCE_MM} mm/side · M3 {CLEARANCE_HOLE_MM.M3} mm, M2 {CLEARANCE_HOLE_MM.M2} mm (ISO 273).</p>
    </div>
  );
}

/** The 3D-print mode, opened on demand. */
function PrintPanelLazy({ asm, download }: { asm: Assembly; download: (name: string, data: BlobPart, type: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="dyn">
      <label className="section-toggle mono">
        <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> 3D PRINT PLANNER
      </label>
      {open && <PrintPanel asm={asm} download={download} />}
    </div>
  );
}

function MassLine({ link, mp, onMass }: { link: Link; mp?: MassProps; onMass: (g: number | undefined) => void }) {
  const rho = DENSITY[link.material ?? 'PLA'];
  return (
    <div className="lab-row small">
      <span className="mono">
        mass {mp ? `${mp.massG.toFixed(1)} g` : '…'}
        {mp?.how === 'solid' && rho && <span className="muted"> · {link.material} {rho.gPerCm3} g/cm³</span>}
        {mp?.how === 'unknown' && <span className="warn-text"> · {mp.note}</span>}
      </span>
      <Num label="massG" step={1} min={0} value={link.massG ?? NaN} onChange={(g) => onMass(g > 0 ? g : undefined)} />
    </div>
  );
}

/** Tendon lines: the most loaded ones, and any that go slack or would have to stretch. */
function TendonsBlock({ all }: { all: TendonReading[] }) {
  const loaded = [...all].sort((a, b) => b.tensionN - a.tensionN).filter((t) => t.tensionN >= 0.05).slice(0, 6);
  const off = all.filter((t) => Math.abs(t.slackMm) > 1);
  return (
    <div className="lab-stack">
      {loaded.length ? (
        <table className="loads mono">
          <tbody>
            {loaded.map((t) => (
              <tr key={t.id} className={t.share >= 1 ? 'over' : t.share > 0.7 ? 'high' : ''}>
                <td title={t.label}>{t.id}</td>
                <td>{t.tensionN.toFixed(1)} N</td>
                <td className="bar-cell">
                  <span className="load-bar" style={{ width: `${Math.min(100, t.share * 100)}%` }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="small muted mono">no line carries load in this pose</p>
      )}
      {off.slice(0, 6).map((t) => (
        <div key={t.id} className={`small mono ${t.slackMm < 0 ? 'warn-text' : 'muted'}`}>
          {t.id}: {t.slackMm > 0 ? `${t.slackMm.toFixed(1)} mm slack` : `stretch ${(-t.slackMm).toFixed(1)} mm`}
        </div>
      ))}
      <p className="small muted" title="Tension = actuator torque share ÷ spool radius (inextensible, frictionless).">
        3D colour: grey (idle) → amber → red (stall).
      </p>
    </div>
  );
}

/** Rapier rigid-body dynamics: inertia, gravity, torque-limited motors, contacts with the bench and loose objects. */
function DynamicsBlock({ d }: { d: PhysicsView['dynamics'] }) {
  const track = d.on && d.ready ? d.tracking() : [];
  const lagging = track.filter((t) => Math.abs(t.commanded - t.actual) > 5);
  const touching = d.on && d.ready ? d.touching() : [];
  const overlaps = d.on && d.ready ? d.restOverlaps() : 0;
  return (
    <div className="lab-stack">
      <label className="section-toggle mono" title="Torque-limited motors, inertia, gravity, and contacts with the bench and loose objects.">
        <input type="checkbox" checked={d.on} onChange={(e) => d.setOn(e.target.checked)} /> DYNAMICS (Rapier)
        {d.on && !d.ready && <span className="muted"> loading…</span>}
      </label>
      {d.on && d.ready && (
        <>
          <div className="lab-row">
            <button onClick={() => d.drop('ball')}>drop ball</button>
            <button onClick={() => d.drop('box')}>drop cube</button>
            <button onClick={d.reset}>reset</button>
          </div>
          <p className="small muted">
            Torque-limited motors + part contacts{overlaps > 0 ? ` (${overlaps} home-pose overlap pair(s) ignored)` : ''}.
          </p>
          {lagging.length ? (
            <table className="loads mono">
              <tbody>
                {lagging.slice(0, 8).map((t) => (
                  <tr key={t.device} className="over">
                    <td>{t.device}</td>
                    <td>cmd {t.commanded.toFixed(0)}°</td>
                    <td>at {t.actual.toFixed(0)}°</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="small ok mono">every joint tracks within 5°</p>
          )}
          {touching.length > 0 && (
            <>
              <p className="small warn-text mono">{touching.length} contact pair(s) (red in 3D)</p>
              {touching.slice(0, 8).map((t) => (
                <div key={`${t.a}|${t.b}`} className="small clash">
                  <b className="mono">{t.a}</b> ↔ <b className="mono">{t.b}</b>
                </div>
              ))}
            </>
          )}
        </>
      )}
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

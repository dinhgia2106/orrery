// The 3D-print mode of the lab: settings, a plan per printed part (orientation, size, overhang, supports,
// filament, bed fit), a preview on the bed, and the files for a slicer.
import { Grid, OrbitControls } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { useMemo, useState } from 'react';
import { BufferAttribute, BufferGeometry } from 'three';
import type { Assembly, Vec3 } from './assembly';
import { DEFAULT_PRINT, DOWNS, planPart, planStl, printPackage, type Down, type PrintPlan, type PrintSettings } from './print';
import type { SolidMesh } from './solid';

/** Which of the part's axes rests on the bed. */
const DOWN_LABEL: Record<Down, string> = { '-y': '−Y', '+y': '+Y', '-x': '−X', '+x': '+X', '-z': '−Z', '+z': '+Z' };
const r1 = (x: number) => (Math.round(x * 10) / 10).toString();

function geometry(m: SolidMesh): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(m.positions, 3));
  g.setIndex(new BufferAttribute(m.triangles, 1));
  const flat = g.toNonIndexed();
  flat.computeVertexNormals();
  return flat;
}

/** The part and its supports on the bed (the slicer's Z up shown as the scene's Y up). */
function Preview({ plan, bed }: { plan: PrintPlan; bed: Vec3 }) {
  const part = useMemo(() => geometry(plan.part), [plan]);
  const sup = useMemo(() => (plan.supports ? geometry(plan.supports) : null), [plan]);
  const span = Math.max(plan.size[0], plan.size[1], plan.size[2], 20);
  return (
    <div className="print-preview">
      <Canvas camera={{ position: [span * 1.3, span * 1.1, span * 1.6], fov: 35, near: 0.5, far: 5000 }} dpr={[1, 2]}>
        <ambientLight intensity={0.8} />
        <directionalLight position={[60, 120, 80]} intensity={1.5} />
        <group rotation={[-Math.PI / 2, 0, 0]}>
          <mesh geometry={part}>
            <meshStandardMaterial color="#d9dee6" roughness={0.7} />
          </mesh>
          {sup && (
            <mesh geometry={sup}>
              <meshStandardMaterial color="#f0a020" roughness={0.8} transparent opacity={0.75} />
            </mesh>
          )}
          {/* build plate outline */}
          <mesh position={[0, 0, -0.05]}>
            <planeGeometry args={[bed[0], bed[1]]} />
            <meshBasicMaterial color={plan.fits ? '#e7eef9' : '#f6d5cf'} />
          </mesh>
        </group>
        <Grid args={[bed[0], bed[1]]} cellSize={10} sectionSize={50} cellColor="#c6d3ea" sectionColor="#7f9fd4" position={[0, 0.01, 0]} />
        <OrbitControls makeDefault target={[0, plan.size[2] / 2, 0]} />
      </Canvas>
    </div>
  );
}

export default function PrintPanel({ asm, download }: { asm: Assembly; download: (name: string, data: BlobPart, type: string) => void }) {
  const printed = asm.links.filter((l) => l.make === 'print' && !('mesh' in l.shape));
  const [s, setS] = useState<PrintSettings>(DEFAULT_PRINT);
  const [plans, setPlans] = useState<Map<string, PrintPlan>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [view, setView] = useState<string | null>(null);

  const planAll = async (settings: PrintSettings) => {
    setBusy('plan');
    const out = new Map<string, PrintPlan>();
    for (const l of printed) {
      setBusy(`plan ${l.id}`);
      const p = await planPart(l, settings);
      if (p) out.set(l.id, p);
      setPlans(new Map(out));
    }
    setBusy(null);
    if (!view && out.size) setView([...out.keys()][0]);
  };
  const replan = async (id: string, settings: PrintSettings) => {
    const l = printed.find((x) => x.id === id);
    if (!l) return;
    setBusy(`plan ${id}`);
    const p = await planPart(l, settings);
    setPlans((m) => {
      const n = new Map(m);
      if (p) n.set(id, p);
      return n;
    });
    setBusy(null);
  };
  const setting = (patch: Partial<PrintSettings>) => {
    setS((x) => ({ ...x, ...patch }));
    setPlans(new Map()); // sizes and supports change with every setting: plan again
  };
  const list = printed.map((l) => plans.get(l.id)).filter((p): p is PrintPlan => !!p);
  const shown = (view && plans.get(view)) || list[0];
  const total = list.reduce((a, p) => a + (p.massG ?? 0) + (p.supportMassG ?? 0), 0);
  const tooBig = list.filter((p) => !p.fits);
  const scaled = list.some((p) => p.scaledFeatures);

  return (
    <div className="print-panel">
      <div className="lab-row small mono">
        <label>
          scale <input type="number" step={0.05} min={0.05} max={10} value={s.scale} onChange={(e) => setting({ scale: Math.max(0.05, Number(e.target.value) || 1) })} style={{ width: 56 }} />
        </label>
        <span className="muted">{Math.round(s.scale * 100)} %</span>
        <label>
          <input type="checkbox" checked={s.supports} onChange={(e) => setting({ supports: e.target.checked })} /> supports
        </label>
        <label>
          overhang <input type="number" step={5} min={10} max={80} value={s.overhangDeg} onChange={(e) => setting({ overhangDeg: Number(e.target.value) || 45 })} style={{ width: 44 }} />°
        </label>
      </div>
      <div className="lab-row small mono">
        bed (your printer)
        {[0, 1, 2].map((i) => (
          <input
            key={i}
            type="number"
            min={10}
            step={5}
            value={s.bed[i]}
            title={['X', 'Y', 'Z'][i]}
            style={{ width: 52 }}
            onChange={(e) => {
              const bed = [...s.bed] as Vec3;
              bed[i] = Math.max(10, Number(e.target.value) || 10);
              setting({ bed });
            }}
          />
        ))}
        mm
      </div>
      <div className="lab-row">
        <button className="primary" disabled={!!busy || !printed.length} onClick={() => void planAll(s)}>
          {busy?.startsWith('plan') ? `planning ${busy.slice(5)}…` : `Plan ${printed.length} printed part(s)`}
        </button>
        <button
          disabled={!!busy || !printed.length}
          onClick={async () => {
            setBusy('zip');
            const { zip, plans: ps } = await printPackage(asm.name, printed, s);
            setPlans(new Map(ps.map((p) => [p.id, p])));
            download(`${asm.name.replace(/[^\w-]+/g, '_')}-print.zip`, zip, 'application/zip');
            setBusy(null);
          }}
        >
          {busy === 'zip' ? 'building…' : 'Print files (ZIP)'}
        </button>
      </div>
      {list.length > 0 && (
        <>
          <table className="loads mono print-table">
            <thead>
              <tr>
                <th>part · X×Y×Z mm</th>
                <th title="the part's axis that rests on the bed">down</th>
                <th title="support volume, cm³">sup.</th>
                <th>g</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} className={`${!p.fits ? 'over' : ''} ${shown?.id === p.id ? 'sel' : ''}`} onClick={() => setView(p.id)}>
                  <td>
                    {p.id}
                    <br />
                    <span className="muted">
                      {r1(p.size[0])}×{r1(p.size[1])}×{r1(p.size[2])}
                    </span>
                  </td>
                  <td>
                    <select
                      value={p.auto ? 'auto' : p.down}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        const down = { ...s.down };
                        if (e.target.value === 'auto') delete down[p.id];
                        else down[p.id] = e.target.value as Down;
                        const next = { ...s, down };
                        setS(next);
                        void replan(p.id, next);
                      }}
                    >
                      <option value="auto">auto {DOWN_LABEL[p.down]}</option>
                      {DOWNS.map((d) => (
                        <option key={d} value={d}>
                          {DOWN_LABEL[d]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>{p.supports ? r1(p.supportVolumeMm3 / 1000) : p.overhangMm2 > 1 ? 'needed' : '—'}</td>
                  <td>{p.massG === null ? '—' : r1(p.massG + (p.supportMassG ?? 0))}</td>
                  <td>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        download(`${p.id}${s.scale !== 1 ? `-x${s.scale}` : ''}.stl`, planStl(p), 'model/stl');
                      }}
                    >
                      STL
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small mono">
            {list.length} part(s) · about {r1(total)} g of filament solid (infill makes it less)
            {tooBig.length > 0 && <span className="warn-text"> · too big for the bed: {tooBig.map((p) => p.id).join(', ')}</span>}
          </p>
          {scaled && <p className="small warn-text">At scale {s.scale}, holes and pockets scale too: they will not fit real screws and SG90s.</p>}
          {shown && <Preview key={`${shown.id}-${shown.down}`} plan={shown} bed={s.bed} />}
          {shown && (
            <p className="small muted mono">
              {shown.id}: {r1(shown.volumeMm3 / 1000)} cm³ · overhang {Math.round(shown.overhangMm2)} mm² {shown.supports ? `· ${r1(shown.supportVolumeMm3 / 1000)} cm³ of support (orange)` : ''}
            </p>
          )}
        </>
      )}
      <p className="small muted">
        "down" is the part's own axis that rests on the bed. Files are Z up, centred and resting on the bed, in mm. Orientation "auto" tries the six ways a part can lie and keeps the one needing least support. Faces leaning more than {s.overhangDeg}° from vertical get {s.column} mm columns every{' '}
        {s.spacing} mm with a {s.gap} mm gap — rules of thumb, not printer data; your slicer's supports may be better. Set the bed to your printer's build volume.
      </p>
    </div>
  );
}

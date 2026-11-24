import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { billOfMaterials, bomCsv, designators } from './lab/bom';
import CodeEditor from './lab/CodeEditor';
import { COMPILER_URL, compileSketch, compilerHealth, type CompileResult } from './lab/compiler';
import { DEVICES, SHELF, type DeviceKind } from './lab/devices';
import {
  TEMPLATES,
  WIRE_COLORS,
  blankProject,
  cloneProject,
  newDevice,
  parseProject,
  projectFromHash,
  projectToHash,
  type Project,
  type Template,
} from './lab/project';
import { useLab } from './lab/useLab';
import Wiring, { RESISTOR_PRESETS, formatOhms, type Selection } from './lab/Wiring';
import { CATALOG, SPEC } from './sim/catalog';
import { parseIntelHex } from './sim/hex';

const Scene = lazy(() => import('./Scene'));
const STORE_KEY = 'orrery.project.v1';
type Tab = 'wiring' | 'code' | '3d';

interface Firmware {
  program: Uint16Array;
  /** The code it was built from (null for an uploaded .hex). */
  code: string | null;
  label: string;
}

function initialProject(): Project {
  const fromLink = projectFromHash(window.location.hash);
  if (fromLink) return fromLink;
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved) return parseProject(saved);
  } catch {
    /* storage unavailable or corrupt: start fresh */
  }
  return cloneProject(TEMPLATES[0].project);
}

/** Only devices, their values and the wires matter to the circuit; positions do not. */
function electricalKey(p: Project): string {
  return JSON.stringify([p.devices.map((d) => [d.id, d.kind, d.props]), p.wires.map((w) => [w.a, w.b])]);
}

async function fetchTemplateHex(t: Template): Promise<Uint16Array> {
  const res = await fetch(`${import.meta.env.BASE_URL}examples/${t.hex}.hex`);
  const text = res.ok ? await res.text() : '';
  if (!text.trimStart().startsWith(':')) throw new Error(`examples/${t.hex}.hex is missing — run "npm run build:examples".`);
  return parseIntelHex(text);
}

function Section({ n, title }: { n: string; title: string }) {
  return (
    <h2 className="section">
      <span className="section-no mono">{n}</span>
      {title}
    </h2>
  );
}

export default function App() {
  const lab = useLab();
  const { sim, snapshot, running, setRunning, speed, setSpeed, realtime, boot } = lab;
  const [project, setProject] = useState<Project>(initialProject);
  const [firmware, setFirmware] = useState<Firmware | null>(null);
  const [tab, setTab] = useState<Tab>('wiring');
  const [selection, setSelection] = useState<Selection>(null);
  const [helper, setHelper] = useState<string | null | undefined>(undefined);
  const [compiling, setCompiling] = useState(false);
  const [result, setResult] = useState<CompileResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [serialIn, setSerialIn] = useState('');
  const electrical = useRef(electricalKey(project));
  const pressStart = useRef(0);

  const refs = useMemo(() => designators(project), [project]);

  // autosave
  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(project));
    } catch {
      /* private mode: fine */
    }
  }, [project]);

  useEffect(() => {
    void compilerHealth().then(setHelper);
  }, []);

  // first run: if the project is an unchanged template, load its prebuilt firmware
  useEffect(() => {
    const t = TEMPLATES.find((x) => x.project.code === project.code);
    if (t)
      void fetchTemplateHex(t)
        .then((program) => {
          setFirmware({ program, code: t.project.code, label: `${t.title} (prebuilt)` });
          boot(project, program);
        })
        .catch((e) => setNotice((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = useCallback(
    (next: Project, isElectrical: boolean) => {
      setProject(next);
      const key = electricalKey(next);
      if (isElectrical && key !== electrical.current && firmware) boot(next, firmware.program); // rewiring = power-cycling the bench
      electrical.current = key;
    },
    [firmware, boot],
  );

  const loadTemplate = async (t: Template) => {
    const p = cloneProject(t.project);
    setProject(p);
    electrical.current = electricalKey(p);
    setSelection(null);
    setResult(null);
    try {
      const program = await fetchTemplateHex(t);
      setFirmware({ program, code: t.project.code, label: `${t.title} (prebuilt)` });
      boot(p, program);
      setNotice(null);
    } catch (e) {
      setNotice((e as Error).message);
    }
  };

  const compileAndRun = async () => {
    setCompiling(true);
    const r = await compileSketch(project.code);
    setCompiling(false);
    setResult(r);
    setHelper(r.ok || r.diagnostics.length ? 'connected' : await compilerHealth());
    if (r.ok && r.program) {
      setFirmware({ program: r.program, code: project.code, label: 'sketch.ino' });
      boot(project, r.program);
    } else setTab('code');
  };

  const addDevice = (kind: DeviceKind) => {
    const others = project.devices.filter((d) => d.kind !== 'uno').length;
    const d = newDevice(kind, project.devices, 420 + (others % 4) * 40, -200 + (others % 6) * 70);
    update({ ...project, devices: [...project.devices, d] }, true);
    setSelection({ type: 'device', id: d.id });
    setTab('wiring');
  };

  const openFile = async (file: File) => {
    try {
      const text = await file.text();
      if (file.name.endsWith('.hex')) {
        const program = parseIntelHex(text);
        setFirmware({ program, code: null, label: file.name });
        boot(project, program);
      } else {
        const p = parseProject(text);
        setProject(p);
        electrical.current = electricalKey(p);
        setSelection(null);
        if (firmware) boot(p, firmware.program);
      }
      setNotice(null);
    } catch (e) {
      setNotice(`Could not open ${file.name}: ${(e as Error).message}`);
    }
  };

  const download = (name: string, text: string, type: string) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    URL.revokeObjectURL(url);
  };

  const share = async () => {
    const url = `${window.location.origin}${window.location.pathname}${projectToHash(project)}`;
    try {
      await navigator.clipboard.writeText(url);
      setNotice('Share link copied to the clipboard.');
    } catch {
      window.history.replaceState(null, '', projectToHash(project));
      setNotice('Share link is now in the address bar.');
    }
  };

  const press = (id: string, down: boolean) => {
    const b = sim.current?.buttons.get(id);
    if (!b) return;
    if (down) {
      pressStart.current = performance.now();
      b.press(true);
    } else {
      // a click counts as at least 50 ms so debounced firmware sees it — a UI choice, not a datasheet figure
      b.press(false, Math.max(0.05, ((performance.now() - pressStart.current) / 1000) * speed));
    }
  };

  const removeDevice = (id: string) => {
    update(
      {
        ...project,
        devices: project.devices.filter((d) => d.id !== id),
        wires: project.wires.filter((w) => !w.a.startsWith(`${id}.`) && !w.b.startsWith(`${id}.`)),
      },
      true,
    );
    setSelection(null);
  };

  const restart = () => firmware && boot(project, firmware.program);
  const stale = !!firmware && firmware.code !== null && firmware.code !== project.code;
  const selDevice = selection?.type === 'device' ? project.devices.find((d) => d.id === selection.id) : undefined;
  const selWire = selection?.type === 'wire' ? project.wires.find((w) => w.id === selection.id) : undefined;
  const railMa = snapshot?.railMa ?? 0;
  const limit = SPEC.uno.usbFuseMa;
  const gaugeMax = limit * 1.5;
  const checks = snapshot?.checks ?? [];
  const bom = billOfMaterials(project);
  const instruments = project.devices.filter((d) => d.kind === 'button' || d.kind === 'pot');
  const pinRef = (ref: string) => ref.replace(/^(\w+)\./, (_, id: string) => `${refs[id] ?? id}.`);

  const setProp = (id: string, props: Record<string, number | string>) =>
    update({ ...project, devices: project.devices.map((d) => (d.id === id ? { ...d, props: { ...d.props, ...props } } : d)) }, true);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="24" height="24">
              <circle cx="16" cy="16" r="3.2" fill="currentColor" />
              <ellipse cx="16" cy="16" rx="13" ry="5" fill="none" stroke="currentColor" strokeWidth="1.2" transform="rotate(-25 16 16)" />
              <circle cx="27" cy="10.8" r="2" fill="currentColor" />
              <path d="M2 16h4M26 16h4M16 2v4M16 26v4" stroke="currentColor" strokeWidth="0.8" />
            </svg>
          </span>
          <strong>Orrery</strong>
          <span className="chip mono">CUSTOM LAB</span>
          <input className="project-name" value={project.name} onChange={(e) => setProject({ ...project, name: e.target.value })} aria-label="Project name" />
        </div>
        <div className="status mono">
          <span className={`dot ${running ? 'on' : ''}`} />
          <span className="readout">
            <i>FW</i>
            {firmware?.label ?? '—'}
            {stale && <em title="The code changed since this firmware was built"> · edited</em>}
          </span>
          <span className="readout">
            <i>T</i>
            {(snapshot?.time ?? 0).toFixed(2)} s
          </span>
          <span className="readout">
            <i>RT</i>
            {(realtime * 100).toFixed(0)} %
          </span>
        </div>
      </header>

      <aside className="panel left">
        <Section n="01" title="Device shelf" />
        <ul className="shelf">
          {SHELF.map((k) => {
            const item = CATALOG[DEVICES[k].catalog];
            return (
              <li key={k}>
                <button onClick={() => addDevice(k)} title={`Add ${DEVICES[k].title}`}>
                  <span className="ref mono">{DEVICES[k].refPrefix}</span>
                  <span className="shelf-name">
                    <strong>{DEVICES[k].title}</strong>
                    <small className="mono">{item.mpn !== '—' ? item.mpn : DEVICES[k].subtitle}</small>
                  </span>
                  <span className="add mono">+</span>
                </button>
              </li>
            );
          })}
        </ul>

        <Section n="02" title="Run" />
        <button className="primary wide" onClick={() => void compileAndRun()} disabled={compiling}>
          {compiling ? 'Compiling…' : 'Compile & run sketch'}
        </button>
        <p className={`helper mono ${helper ? 'ok' : 'off'}`}>
          {helper === undefined ? 'checking compile helper…' : helper ? '● compile helper connected' : '○ no compile helper — run "npm run compiler"'}
        </p>
        <div className="controls">
          <button onClick={() => setRunning(!running)} disabled={!sim.current || !!sim.current?.fatal.length}>
            {running ? 'Pause' : 'Run'}
          </button>
          <button onClick={restart} disabled={!firmware}>
            Reset
          </button>
        </div>
        <label className="slider">
          <span className="slider-head mono">
            <span>SPEED</span>
            <b>×{speed.toFixed(1)}</b>
          </span>
          <input type="range" min={0.1} max={2} step={0.1} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
        </label>

        <Section n="03" title="Project" />
        <div className="file-row">
          <button onClick={() => update(blankProject(), true)}>New</button>
          <label className="file-btn">
            Open
            <input type="file" accept=".json,.hex" onChange={(e) => e.target.files?.[0] && void openFile(e.target.files[0])} />
          </label>
          <button onClick={() => download(`${project.name.replace(/[^\w-]+/g, '_') || 'bench'}.orrery.json`, JSON.stringify(project, null, 2), 'application/json')}>Save</button>
          <button onClick={() => void share()}>Share</button>
        </div>
        <p className="muted small">Open takes a saved project (.json) or firmware (.hex). Projects autosave in this browser.</p>
        {notice && <p className="notice small">{notice}</p>}

        <Section n="04" title="Templates" />
        <ul className="examples">
          {TEMPLATES.map((t, i) => (
            <li key={t.id}>
              <button onClick={() => void loadTemplate(t)}>
                <span className="ex-no mono">TPL-{String(i + 1).padStart(2, '0')}</span>
                <strong>{t.title}</strong>
                <span>{t.summary}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="stage">
        <nav className="tabs mono">
          {(['wiring', 'code', '3d'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t === 'wiring' ? 'FIG. 1 — WIRING' : t === 'code' ? 'SKETCH.INO' : 'FIG. 2 — 3D BENCH'}
              {t === 'code' && stale && <span className="badge">edited</span>}
              {t === 'code' && result && !result.ok && <span className="badge err">errors</span>}
            </button>
          ))}
        </nav>
        <div className="tab-body">
          {tab === 'wiring' && (
            <>
              <Wiring project={project} onChange={update} selection={selection} onSelect={setSelection} snapshot={snapshot} refs={refs} onPress={press} />
              <div className="overlay" aria-hidden="true">
                <span className="crop tl" />
                <span className="crop tr" />
                <span className="crop bl" />
                <span className="crop br" />
                <div className="fig bottom mono">
                  click a pin, then another pin, to run a wire
                  <small>drag parts · drag the background to pan · wheel to zoom · Delete removes the selection</small>
                </div>
                <TitleBlock project={project} firmware={firmware?.label} />
              </div>
            </>
          )}
          {tab === 'code' && (
            <div className="code-pane">
              <CodeEditor code={project.code} onChange={(code) => setProject({ ...project, code })} onCompile={() => void compileAndRun()} diagnostics={result?.diagnostics ?? []} />
              {result && <pre className={`compile-log mono ${result.ok ? 'ok' : 'err'}`}>{result.log || (result.ok ? 'Compiled.' : 'Failed.')}</pre>}
            </div>
          )}
          {tab === '3d' && (
            <>
              <Suspense fallback={<div className="loading mono">LOADING 3D SCENE…</div>}>
                <Scene sim={sim} project={project} />
              </Suspense>
              <div className="overlay" aria-hidden="true">
                <span className="crop tl" />
                <span className="crop tr" />
                <span className="crop bl" />
                <span className="crop br" />
                <div className="grid-note mono">
                  <span className="grid-swatch" /> GRID 10 mm
                </div>
                <TitleBlock project={project} firmware={firmware?.label} />
              </div>
            </>
          )}
        </div>
      </main>

      <aside className="panel right">
        <Section n="05" title="Inspector" />
        {selDevice ? (
          <div className="card inspector">
            <div className="part-head">
              <span className="ref mono">{refs[selDevice.id]}</span>
              <strong>{DEVICES[selDevice.kind].title}</strong>
              <span className="pin mono">{DEVICES[selDevice.kind].subtitle}</span>
            </div>
            {selDevice.kind === 'resistor' && (
              <label className="field mono">
                <span>VALUE</span>
                <select value={selDevice.props.ohms ?? 220} onChange={(e) => setProp(selDevice.id, { ohms: Number(e.target.value) })}>
                  {RESISTOR_PRESETS.map((o) => (
                    <option key={o} value={o}>
                      {formatOhms(o)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {selDevice.kind === 'psu' && (
              <label className="field mono">
                <span>OUTPUT V</span>
                <input type="number" min={0} max={35} step={0.1} value={selDevice.props.volts ?? 12} onChange={(e) => setProp(selDevice.id, { volts: Math.min(35, Math.max(0, Number(e.target.value))) })} />
              </label>
            )}
            {selDevice.kind === 'cap' && (
              <label className="field mono">
                <span>µF</span>
                <input type="number" min={1} max={10000} step={1} value={selDevice.props.uf ?? 100} onChange={(e) => setProp(selDevice.id, { uf: Math.max(1, Number(e.target.value)) })} />
              </label>
            )}
            <StateList state={snapshot?.devices[selDevice.id]} />
            {selDevice.kind === 'uno' && <p className="muted small">Hover a header pin in the wiring view to see its mode and voltage.</p>}
            {selDevice.id !== 'uno' && (
              <button className="danger" onClick={() => removeDevice(selDevice.id)}>
                Remove {refs[selDevice.id]}
              </button>
            )}
          </div>
        ) : selWire ? (
          <div className="card inspector">
            <div className="part-head">
              <span className="ref mono">W</span>
              <strong className="mono">
                {pinRef(selWire.a)} → {pinRef(selWire.b)}
              </strong>
            </div>
            <div className="swatches">
              {WIRE_COLORS.map((c) => (
                <button
                  key={c}
                  style={{ background: c }}
                  className={c === selWire.color ? 'on' : ''}
                  onClick={() => setProject({ ...project, wires: project.wires.map((w) => (w.id === selWire.id ? { ...w, color: c } : w)) })}
                  aria-label={`colour ${c}`}
                />
              ))}
            </div>
            <button
              className="danger"
              onClick={() => {
                update({ ...project, wires: project.wires.filter((w) => w.id !== selWire.id) }, true);
                setSelection(null);
              }}
            >
              Remove wire
            </button>
          </div>
        ) : (
          <p className="muted small">Select a part or a wire. Add parts from the shelf, wire them pin to pin, write the sketch, then Compile &amp; run.</p>
        )}

        {instruments.length > 0 && (
          <>
            <Section n="06" title="Controls" />
            <ul className="parts">
              {instruments.map((d) =>
                d.kind === 'button' ? (
                  <li key={d.id}>
                    <div className="part-head">
                      <span className="ref mono">{refs[d.id]}</span>
                      <strong>Push button</strong>
                    </div>
                    <button
                      className="press"
                      onPointerDown={() => press(d.id, true)}
                      onPointerUp={() => press(d.id, false)}
                      onPointerLeave={() => sim.current?.buttons.get(d.id)?.pressed && press(d.id, false)}
                    >
                      Hold to press
                    </button>
                  </li>
                ) : (
                  <li key={d.id}>
                    <div className="part-head">
                      <span className="ref mono">{refs[d.id]}</span>
                      <strong>Potentiometer</strong>
                      <span className="pin mono">wiper {String(snapshot?.devices[d.id]?.wiper ?? '—')} V</span>
                    </div>
                    <input type="range" min={0} max={1} step={0.01} defaultValue={0.5} onChange={(e) => sim.current?.pots.get(d.id)?.set(Number(e.target.value))} />
                  </li>
                ),
              )}
            </ul>
          </>
        )}

        <Section n="07" title="Checks" />
        {checks.length ? (
          <ul className="warnings">
            {checks.map((c, i) => (
              <li
                key={i}
                className={c.level}
                onClick={() => {
                  if (!c.device) return;
                  setSelection({ type: 'device', id: c.device });
                  setTab('wiring');
                }}
              >
                {c.device && <b className="mono">{refs[c.device]} </b>}
                {c.msg}
              </li>
            ))}
          </ul>
        ) : (
          <p className="ok mono">{snapshot ? '✓ NO PROBLEMS DETECTED' : 'not running'}</p>
        )}

        <Section n="08" title="Power · 5 V rail" />
        <div className={`gauge ${railMa > limit ? 'over' : ''}`}>
          <div className="gauge-bar">
            <span className="gauge-fill" style={{ width: `${Math.min(100, (railMa / gaugeMax) * 100)}%` }} />
            <span className="gauge-limit" style={{ left: `${(limit / gaugeMax) * 100}%` }} />
          </div>
          <div className="gauge-scale mono">
            <span>0</span>
            <span style={{ left: `${(limit / gaugeMax) * 100}%` }}>{limit} mA fuse</span>
          </div>
          <p className="mono gauge-read">
            peak <b>~{railMa} mA</b>
          </p>
        </div>
        <p className="muted small">Solved from your wiring; the Uno's own draw and servo current are approximations.</p>

        <Section n="09" title="Serial monitor" />
        <pre className="serial">{snapshot?.serial || '—'}</pre>
        <form
          className="serial-in"
          onSubmit={(e) => {
            e.preventDefault();
            sim.current?.sendSerial(`${serialIn}\n`);
            setSerialIn('');
          }}
        >
          <input className="mono" value={serialIn} onChange={(e) => setSerialIn(e.target.value)} placeholder="send to Serial (newline added)" />
          <button type="submit">Send</button>
        </form>

        <Section n="10" title="Bill of materials" />
        <ul className="bom">
          {bom.map((l) => (
            <li key={l.item.key}>
              <div className="part-head">
                <span className="ref mono">{l.refs.join(', ')}</span>
                <strong>{l.item.name}</strong>
                <span className="pin mono">QTY {l.qty}</span>
              </div>
              <div className="mono">
                {l.item.manufacturer} <b className="mpn">{l.item.mpn}</b>
              </div>
              {l.values.length > 0 && <div className="bom-specs mono">{l.values.join(' · ')}</div>}
              <div className="bom-specs muted">{l.item.specs.join(' · ')}</div>
              {l.item.notes?.map((n) => (
                <div key={n} className="bom-note">
                  {n}
                </div>
              ))}
              <div className="bom-links">
                <a href={l.item.url} target="_blank" rel="noreferrer">
                  Product page
                </a>
                <a href={l.item.datasheet.url} target="_blank" rel="noreferrer">
                  Datasheet
                </a>
              </div>
            </li>
          ))}
        </ul>
        <p className="muted small">Not listed: jumper wires, breadboard. Printed arm parts are custom.</p>
        <button className="press" onClick={() => download('orrery-bom.csv', bomCsv(bom), 'text/csv')}>
          Export BOM (.csv)
        </button>
        <p className="muted small">Compile helper: {COMPILER_URL}</p>
      </aside>
    </div>
  );
}

function StateList({ state }: { state?: Record<string, number | boolean | string> }) {
  if (!state) return null;
  return (
    <dl className="part-state mono">
      {Object.entries(state).map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function TitleBlock({ project, firmware }: { project: Project; firmware?: string }) {
  return (
    <table className="titleblock mono">
      <tbody>
        <tr>
          <th>PROJECT</th>
          <td colSpan={3}>{project.name}</td>
        </tr>
        <tr>
          <th>FIRMWARE</th>
          <td colSpan={3}>{firmware ?? '—'}</td>
        </tr>
        <tr>
          <th>PARTS</th>
          <td>{project.devices.length}</td>
          <th>WIRES</th>
          <td>{project.wires.length}</td>
        </tr>
      </tbody>
    </table>
  );
}

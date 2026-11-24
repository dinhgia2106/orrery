import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { CUSTOM_PARTS, EXAMPLES, type Example } from './examples';
import { SPEC } from './sim/catalog';
import { billOfMaterials, type BomLine, type PartSpec } from './sim/engine';
import { parseIntelHex } from './sim/hex';
import { Button, Potentiometer } from './sim/parts';
import { useSimulation } from './useSimulation';

const Scene = lazy(() => import('./Scene'));

function describePin(spec: PartSpec): string {
  return spec.type === 'stepper' ? `STEP ${spec.step} · DIR ${spec.dir}` : spec.pin;
}

function label(spec: PartSpec): string {
  switch (spec.type) {
    case 'led':
      return spec.builtin ? 'On-board LED "L"' : 'LED 5 mm · WP7113ID';
    case 'servo':
      return 'Servo · TowerPro SG90';
    case 'stepper':
      return 'NEMA 17 + A4988';
    case 'button':
      return 'Button · Omron B3F-1000';
    case 'pot':
      return 'Pot · Bourns PTV09 10 kΩ';
  }
}

function Section({ n, title }: { n: string; title: string }) {
  return (
    <h2 className="section">
      <span className="section-no mono">{n}</span>
      {title}
    </h2>
  );
}

/** Reference designators as on a schematic: U board/driver, M motor, SW switch, RV pot, D LED. */
function designators(specs: PartSpec[]): Record<string, string> {
  const count: Record<string, number> = { U: 1, M: 0, SW: 0, RV: 0, D: 0 };
  const next = (p: string) => `${p}${++count[p]}`;
  const out: Record<string, string> = {};
  for (const s of specs) {
    if (s.type === 'led') out[s.id] = s.builtin ? 'U1·L' : next('D');
    if (s.type === 'servo') out[s.id] = next('M');
    if (s.type === 'stepper') out[s.id] = `${next('M')}/${next('U')}`;
    if (s.type === 'button') out[s.id] = next('SW');
    if (s.type === 'pot') out[s.id] = next('RV');
  }
  return out;
}

function bomCsv(lines: BomLine[]): string {
  const q = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [['Qty', 'Part', 'Manufacturer', 'MPN', 'Used by', 'Product page', 'Datasheet']];
  for (const l of lines) rows.push([String(l.qty), l.item.name, l.item.manufacturer, l.item.mpn, l.usedBy.join(' '), l.item.url, l.item.datasheet.url]);
  return rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
}

function Bom({ parts, refs }: { parts: PartSpec[]; refs: Record<string, string> }) {
  const lines = billOfMaterials(parts);
  const download = () => {
    const url = URL.createObjectURL(new Blob([bomCsv(lines)], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'orrery-bom.csv' });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <>
      <ul className="bom">
        {lines.map((l) => (
          <li key={l.item.key}>
            <div className="part-head">
              <span className="ref mono">{l.usedBy.map((id) => (id === 'board' ? 'U1' : refs[id])).join(', ')}</span>
              <strong>{l.item.name}</strong>
              <span className="pin mono">QTY {l.qty}</span>
            </div>
            <div className="mono">
              {l.item.manufacturer} <b className="mpn">{l.item.mpn}</b>
            </div>
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
      <p className="muted small">
        Not listed: breadboard, jumper wires, a separate 5 V supply for servos and an {SPEC.a4988.vmotMinV}–{SPEC.a4988.vmotMaxV} V supply for the
        A4988 motor side. Printed arm parts are custom.
      </p>
      <button className="press" onClick={download}>
        Export BOM (.csv)
      </button>
    </>
  );
}

export default function App() {
  const { sim, snapshot, running, setRunning, speed, setSpeed, realtime, load } = useSimulation();
  const [example, setExample] = useState<Example>(EXAMPLES[0]);
  const [parts, setParts] = useState<PartSpec[]>(EXAMPLES[0].parts);
  const [error, setError] = useState<string | null>(null);
  const [firmwareName, setFirmwareName] = useState('');
  const loaded = useRef<{ program: Uint16Array; parts: PartSpec[] } | null>(null);

  const boot = useCallback(
    (program: Uint16Array, specs: PartSpec[], name: string) => {
      loaded.current = { program, parts: specs };
      setParts(specs);
      setFirmwareName(name);
      load(program, specs);
    },
    [load],
  );

  const start = useCallback(
    async (ex: Example) => {
      setExample(ex);
      setError(null);
      try {
        boot(await ex.firmware(), ex.parts, ex.title);
      } catch (e) {
        setRunning(false);
        setError((e as Error).message);
      }
    },
    [boot, setRunning],
  );

  useEffect(() => {
    void start(EXAMPLES[0]);
  }, [start]);

  const onHex = async (file: File) => {
    try {
      const program = parseIntelHex(await file.text());
      setError(null);
      boot(program, CUSTOM_PARTS, file.name);
    } catch (e) {
      setError(`Could not read ${file.name}: ${(e as Error).message}`);
    }
  };

  // How long the user held a button, in simulated seconds (wall time × speed). A click counts as at least
  // 50 ms so firmware that debounces still sees it — a UI choice, not a measured or datasheet figure.
  const pressStart = useRef(0);
  const heldSimSec = () => Math.max(0.05, ((performance.now() - pressStart.current) / 1000) * speed);

  const restart = () => {
    if (loaded.current) load(loaded.current.program, loaded.current.parts);
  };

  const refs = designators(parts);
  const railMa = snapshot?.railMa ?? 0;
  const limit = SPEC.uno.usbFuseMa;
  const gaugeMax = limit * 1.5;

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
          <span className="chip mono">LAB BENCH · REV B</span>
          <span className="tagline">build it in the browser before you build it for real</span>
        </div>
        <div className="status mono">
          <span className={`dot ${running ? 'on' : ''}`} />
          <span className="readout">
            <i>FW</i>
            {firmwareName || '—'}
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
        <Section n="01" title="Examples" />
        <ul className="examples">
          {EXAMPLES.map((ex, i) => (
            <li key={ex.id}>
              <button className={ex.id === example.id && firmwareName === ex.title ? 'active' : ''} onClick={() => void start(ex)}>
                <span className="ex-no mono">EX-{String(i + 1).padStart(2, '0')}</span>
                <strong>{ex.title}</strong>
                <span>{ex.summary}</span>
              </button>
            </li>
          ))}
        </ul>
        <label className="upload">
          <input type="file" accept=".hex" onChange={(e) => e.target.files?.[0] && void onHex(e.target.files[0])} />
          <span className="mono">+ LOAD .HEX</span>
          <small>Wired like the robot arm: servo D9, stepper D3/D4, button D2, pot A0, LED D13.</small>
        </label>

        <Section n="02" title="Run" />
        <div className="controls">
          <button onClick={() => setRunning(!running)} disabled={!sim.current}>{running ? 'Pause' : 'Run'}</button>
          <button onClick={restart} disabled={!sim.current}>Reset</button>
        </div>
        <label className="slider">
          <span className="slider-head mono">
            <span>SPEED</span>
            <b>×{speed.toFixed(1)}</b>
          </span>
          <input type="range" min={0.1} max={2} step={0.1} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
          <span className="ticks mono" aria-hidden="true">
            <span>0.1</span>
            <span>1.0</span>
            <span>2.0</span>
          </span>
        </label>
        {error && <p className="error">{error}</p>}
      </aside>

      <main className="stage">
        <Suspense fallback={<div className="loading mono">LOADING 3D SCENE…</div>}>
          <Scene sim={sim} specs={parts} />
        </Suspense>
        <div className="overlay" aria-hidden="true">
          <span className="crop tl" />
          <span className="crop tr" />
          <span className="crop bl" />
          <span className="crop br" />
          <div className="fig mono">
            FIG. 1 — BENCH, PERSPECTIVE
            <small>drag to orbit · scroll to zoom</small>
          </div>
          <div className="grid-note mono">
            <span className="grid-swatch" /> GRID 10 mm
          </div>
          <table className="titleblock mono">
            <tbody>
              <tr>
                <th>PROJECT</th>
                <td colSpan={3}>ORRERY</td>
              </tr>
              <tr>
                <th>FIRMWARE</th>
                <td colSpan={3}>{firmwareName || '—'}</td>
              </tr>
              <tr>
                <th>BOARD</th>
                <td>A000066</td>
                <th>PARTS</th>
                <td>{parts.length}</td>
              </tr>
              <tr>
                <th>UNITS</th>
                <td>mm</td>
                <th>SHEET</th>
                <td>1 / 1</td>
              </tr>
            </tbody>
          </table>
        </div>
      </main>

      <aside className="panel right">
        <Section n="03" title="Parts" />
        <ul className="parts">
          {parts.map((spec) => {
            const st = snapshot?.parts[spec.id];
            const part = sim.current?.part(spec.id);
            return (
              <li key={spec.id}>
                <div className="part-head">
                  <span className="ref mono">{refs[spec.id]}</span>
                  <strong>{label(spec)}</strong>
                  <span className="pin mono">{describePin(spec)}</span>
                </div>
                {st && (
                  <dl className="part-state mono">
                    {Object.entries(st)
                      .filter(([k]) => k !== 'type')
                      .map(([k, v]) => (
                        <div key={k}>
                          <dt>{k}</dt>
                          <dd>{String(v)}</dd>
                        </div>
                      ))}
                  </dl>
                )}
                {part instanceof Button && (
                  <button
                    className="press"
                    onPointerDown={() => {
                      pressStart.current = performance.now();
                      part.press(true);
                    }}
                    onPointerUp={() => part.press(false, heldSimSec())}
                    onPointerLeave={() => part.pressed && part.press(false, heldSimSec())}
                  >
                    Hold to press
                  </button>
                )}
                {part instanceof Potentiometer && (
                  <input type="range" min={0} max={1} step={0.01} defaultValue={part.value} onChange={(e) => part.set(Number(e.target.value))} />
                )}
              </li>
            );
          })}
        </ul>

        <Section n="04" title="Power · 5 V rail" />
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
        <p className="muted small">Approx.: the Uno's own draw and the SG90 current are not in their datasheets.</p>

        <Section n="05" title="Checks" />
        {snapshot?.warnings.length ? (
          <ul className="warnings">
            {snapshot.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : (
          <p className="ok mono">✓ NO PROBLEMS DETECTED</p>
        )}

        <Section n="06" title="Serial monitor" />
        <pre className="serial">{snapshot?.serial || '—'}</pre>

        <Section n="07" title="Bill of materials" />
        <Bom parts={parts} refs={refs} />
      </aside>
    </div>
  );
}

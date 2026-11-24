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

function bomCsv(lines: BomLine[]): string {
  const q = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [['Qty', 'Part', 'Manufacturer', 'MPN', 'Used by', 'Product page', 'Datasheet']];
  for (const l of lines) rows.push([String(l.qty), l.item.name, l.item.manufacturer, l.item.mpn, l.usedBy.join(' '), l.item.url, l.item.datasheet.url]);
  return rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
}

function Bom({ parts }: { parts: PartSpec[] }) {
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
              <strong>
                {l.qty}× {l.item.name}
              </strong>
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

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="22" height="22">
              <circle cx="16" cy="16" r="3.2" fill="currentColor" />
              <ellipse cx="16" cy="16" rx="13" ry="5" fill="none" stroke="currentColor" strokeWidth="1.4" transform="rotate(-25 16 16)" />
              <circle cx="27" cy="10.8" r="2" fill="currentColor" />
            </svg>
          </span>
          <strong>Orrery</strong>
          <span className="tagline">build it in the browser before you build it for real</span>
        </div>
        <div className="status">
          <span className={`dot ${running ? 'on' : ''}`} />
          <span>{firmwareName || 'no firmware'}</span>
          <span className="mono">t = {(snapshot?.time ?? 0).toFixed(2)} s</span>
          <span className="mono muted">{(realtime * 100).toFixed(0)}% real time</span>
        </div>
      </header>

      <aside className="panel left">
        <h2>Examples</h2>
        <ul className="examples">
          {EXAMPLES.map((ex) => (
            <li key={ex.id}>
              <button className={ex.id === example.id && firmwareName === ex.title ? 'active' : ''} onClick={() => void start(ex)}>
                <strong>{ex.title}</strong>
                <span>{ex.summary}</span>
              </button>
            </li>
          ))}
        </ul>
        <label className="upload">
          <input type="file" accept=".hex" onChange={(e) => e.target.files?.[0] && void onHex(e.target.files[0])} />
          Load your own .hex
          <small>Wired like the robot arm: servo D9, stepper D3/D4, button D2, pot A0, LED D13.</small>
        </label>

        <h2>Run</h2>
        <div className="controls">
          <button onClick={() => setRunning(!running)} disabled={!sim.current}>{running ? 'Pause' : 'Run'}</button>
          <button onClick={restart} disabled={!sim.current}>Reset</button>
        </div>
        <label className="slider">
          Speed ×{speed}
          <input type="range" min={0.1} max={2} step={0.1} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
        </label>
        {error && <p className="error">{error}</p>}
      </aside>

      <main className="stage">
        <Suspense fallback={<div className="loading">Loading 3D scene…</div>}>
          <Scene sim={sim} specs={parts} />
        </Suspense>
      </main>

      <aside className="panel right">
        <h2>Parts</h2>
        <ul className="parts">
          {parts.map((spec) => {
            const st = snapshot?.parts[spec.id];
            const part = sim.current?.part(spec.id);
            return (
              <li key={spec.id}>
                <div className="part-head">
                  <strong>{label(spec)}</strong>
                  <span className="mono muted">{describePin(spec)}</span>
                </div>
                {st && (
                  <div className="part-state mono">
                    {Object.entries(st)
                      .filter(([k]) => k !== 'type')
                      .map(([k, v]) => (
                        <span key={k}>
                          {k} <b>{String(v)}</b>
                        </span>
                      ))}
                  </div>
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

        <h2>Power</h2>
        <p className="mono">
          Peak 5 V rail <b>~{snapshot?.railMa ?? 0} mA</b> / {SPEC.uno.usbFuseMa} mA USB fuse
        </p>
        <p className="muted small">Approx.: the Uno's own draw and the SG90 current are not in their datasheets.</p>

        <h2>Checks</h2>
        {snapshot?.warnings.length ? (
          <ul className="warnings">
            {snapshot.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">No problems detected.</p>
        )}

        <h2>Serial monitor</h2>
        <pre className="serial">{snapshot?.serial || '—'}</pre>

        <h2>Bill of materials</h2>
        <Bom parts={parts} />
      </aside>
    </div>
  );
}

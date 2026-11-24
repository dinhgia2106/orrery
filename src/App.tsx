import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { CUSTOM_PARTS, EXAMPLES, type Example } from './examples';
import type { PartSpec } from './sim/engine';
import { parseIntelHex } from './sim/hex';
import { Button, Potentiometer } from './sim/parts';
import { useSimulation } from './useSimulation';

const Scene = lazy(() => import('./Scene'));

function describePin(spec: PartSpec): string {
  return spec.type === 'stepper' ? `STEP ${spec.step} · DIR ${spec.dir}` : spec.pin;
}

const LABELS: Record<string, string> = {
  led: 'LED',
  servo: 'Servo SG90',
  stepper: 'Stepper · A4988',
  button: 'Push button',
  pot: 'Potentiometer',
};

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
          <Scene sim={sim} />
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
                  <strong>{LABELS[spec.type]}</strong>
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
                    onPointerDown={() => part.press(true)}
                    onPointerUp={() => part.press(false)}
                    onPointerLeave={() => part.pressed && part.press(false)}
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
          Peak 5 V rail <b>{snapshot?.railMa ?? 0} mA</b> / 500 mA USB
        </p>

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
      </aside>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { Simulation, type PartSpec, type Snapshot } from './sim/engine';

const MAX_FRAME = 0.05; // never simulate more than 50 ms per animation frame

export function useSimulation() {
  const simRef = useRef<Simulation | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [realtime, setRealtime] = useState(1);

  const load = useCallback((program: Uint16Array, parts: PartSpec[]) => {
    simRef.current = new Simulation(program, parts);
    setSnapshot(simRef.current.snapshot());
    setRunning(true);
  }, []);

  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let last = performance.now();
    let frames = 0;
    let simSpent = 0;
    let wallSpent = 0;
    const tick = (now: number) => {
      const sim = simRef.current;
      const wall = Math.min((now - last) / 1000, MAX_FRAME);
      last = now;
      if (sim) {
        const t0 = performance.now();
        sim.step(wall * speed);
        const cost = (performance.now() - t0) / 1000;
        simSpent += wall * speed;
        wallSpent += Math.max(cost, wall);
        if (++frames % 6 === 0) {
          setSnapshot(sim.snapshot());
          setRealtime(simSpent / wallSpent);
          simSpent = wallSpent = 0;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running, speed]);

  return { sim: simRef, snapshot, running, setRunning, speed, setSpeed, realtime, load };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { LabSimulation, type LabSnapshot } from './labsim';
import type { Project } from './project';

const MAX_FRAME = 0.05; // never simulate more than 50 ms per animation frame

/** Runs a LabSimulation on the main thread, paced by requestAnimationFrame. */
export function useLab() {
  const simRef = useRef<LabSimulation | null>(null);
  const [snapshot, setSnapshot] = useState<LabSnapshot | null>(null);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [realtime, setRealtime] = useState(1);

  /** Start the bench from scratch with firmware per board id (boards without one run a blank chip). */
  const boot = useCallback((project: Project, programs: Record<string, Uint16Array>) => {
    const sim = new LabSimulation(project, programs);
    simRef.current = sim;
    setSnapshot(sim.snapshot());
    setRunning(sim.fatal.length === 0);
  }, []);

  const stop = useCallback(() => {
    simRef.current = null;
    setSnapshot(null);
    setRunning(false);
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

  return { sim: simRef, snapshot, setSnapshot, running, setRunning, speed, setSpeed, realtime, boot, stop };
}

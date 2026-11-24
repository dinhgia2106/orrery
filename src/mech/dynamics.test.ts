import { describe, expect, it } from 'vitest';
import type { Assembly } from './assembly';
import { Dynamics, G, loadRapier } from './dynamics';
import { massProperties } from './physics';

/** A fixed base and a 100 × 10 × 10 mm PLA bar hinged at one end about Z, 200 mm above the bench. */
function pendulum(opts: { driven?: boolean; massG?: number } = {}): Assembly {
  return {
    format: 'orrery.assembly',
    version: 1,
    name: 'pendulum',
    units: 'mm',
    placement: [0, 0, 0],
    links: [
      { id: 'base', shape: { box: [40, 10, 40] }, position: [0, 5, 0], material: 'PLA', make: 'print' },
      { id: 'bar', shape: { box: [100, 10, 10] }, position: [50, 0, 0], material: 'PLA', make: 'print', ...(opts.massG ? { massG: opts.massG } : {}) },
    ],
    joints: [
      {
        id: 'hinge',
        type: 'revolute',
        parent: 'base',
        child: 'bar',
        position: [0, 200, 0],
        axis: [0, 0, 1],
        ...(opts.driven ? { drive: { device: 'servo1', from: [0, 180] as [number, number], to: [-90, 90] as [number, number] } } : {}),
      },
    ],
    mounts: opts.driven ? [{ device: 'servo1', kind: 'servo', link: 'base', position: [0, 10, 0] }] : [],
  };
}

describe('rigid-body dynamics (Rapier)', () => {
  it('a hinged bar swings with the period of a physical pendulum', async () => {
    const lib = await loadRapier();
    const a = pendulum();
    const dyn = new Dynamics(lib, a, await massProperties(a), new Map([['hinge', -85]])); // 5° from hanging straight down
    const crossings: number[] = [];
    let t = 0;
    let prev = dyn.jointAngles().get('hinge')! + 90;
    while (t < 2) {
      dyn.step(1 / 240, () => undefined);
      t += 1 / 240;
      const now = dyn.jointAngles().get('hinge')! + 90;
      if (prev > 0 && now <= 0) crossings.push(t);
      prev = now;
    }
    // T = 2π √(I / (m g d)), I about the hinge = m (L² + h²)/12 + m d², L = 100 mm, h = 10 mm, d = 50 mm
    const I = (0.1 ** 2 + 0.01 ** 2) / 12 + 0.05 ** 2; // per kg
    const expected = 2 * Math.PI * Math.sqrt(I / (G * 0.05));
    const period = (crossings[crossings.length - 1] - crossings[0]) / (crossings.length - 1);
    expect(crossings.length).toBeGreaterThanOrEqual(3);
    expect(period).toBeGreaterThan(expected * 0.98);
    expect(period).toBeLessThan(expected * 1.02);
    dyn.dispose();
  });

  it('an SG90 holds a light bar level; a bar beyond its stall torque sags to where gravity and stall balance', async () => {
    const lib = await loadRapier();
    const run = async (massG?: number) => {
      const a = pendulum({ driven: true, massG });
      const dyn = new Dynamics(lib, a, await massProperties(a), new Map([['hinge', 0]]));
      let min = 0;
      for (let i = 0; i < 3 * 240; i++) {
        dyn.step(1 / 240, () => 90); // servo at 90° commands the bar level
        min = Math.min(min, dyn.jointAngles().get('hinge')!);
      }
      const end = dyn.jointAngles().get('hinge')!;
      dyn.dispose();
      return { min, end };
    };
    const light = await run(); // 12.4 g at 50 mm ≈ 0.06 kgf·cm
    expect(Math.abs(light.end)).toBeLessThan(2);
    // 400 g at 50 mm = 2.0 kgf·cm·cos θ against a 1.8 kgf·cm stall: balance at θ = −acos(0.9) ≈ −25.8°;
    // with the motor saturated the bar swings about it, bottoming out near −46° (energy balance)
    const heavy = await run(400);
    expect(heavy.min).toBeLessThan(-20);
    expect(heavy.min).toBeGreaterThan(-60);
    expect(heavy.end).toBeLessThan(-5);
  });

  it('a dropped ball comes to rest on the bench', async () => {
    const lib = await loadRapier();
    const a = pendulum();
    const dyn = new Dynamics(lib, a, await massProperties(a), new Map([['hinge', -90]]));
    const ball = dyn.drop('ball', 30, [300, 100, 0]);
    dyn.step(2, () => undefined);
    const y = ball.body.translation().y * 1000;
    expect(y).toBeGreaterThan(14);
    expect(y).toBeLessThan(16);
    dyn.dispose();
  });
});

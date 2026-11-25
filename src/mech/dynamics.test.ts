import { describe, expect, it } from 'vitest';
import type { Assembly } from './assembly';
import { Dynamics, G, loadRapier } from './dynamics';
import { TEMPLATES } from '../lab/project';
import { jointValues } from './assembly';
import { massProperties } from './physics';

/** A fixed base and a 100 × 10 × 10 mm PLA bar hinged at one end about Z, 200 mm above the bench. */
function pendulum(opts: { driven?: boolean; massG?: number; post?: [number, number] } = {}): Assembly {
  const a: Assembly = {
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
  if (opts.post) {
    // a 10 × 10 × 40 mm post fixed to the base, centred at (x, y) in the bar's swing plane
    a.links.push({ id: 'post', shape: { box: [10, 10, 40] }, position: [0, 0, 0], material: 'PLA', make: 'print' });
    a.joints.push({ id: 'post-fix', type: 'fixed', parent: 'base', child: 'post', position: [opts.post[0], opts.post[1], 0] });
  }
  return a;
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

  it('a moving part is stopped by another part in its path, and the contact is reported', async () => {
    const lib = await loadRapier();
    // post 60 mm out, 50 mm below the hinge: the bar meets it near −35° on its way down to −90°
    const a = pendulum({ driven: true, post: [60, 150] });
    const dyn = new Dynamics(lib, a, await massProperties(a), new Map([['hinge', 0]]));
    expect(dyn.restOverlaps()).toBe(0);
    for (let i = 0; i < 2 * 240; i++) dyn.step(1 / 240, () => 0); // servo at 0° commands the bar straight down
    const end = dyn.jointAngles().get('hinge')!;
    expect(end).toBeGreaterThan(-50);
    expect(end).toBeLessThan(-20);
    expect(dyn.touching()).toEqual([{ a: 'bar', b: 'post' }]);
    dyn.dispose();
  });

  it('parts that overlap in the home pose are left out of collision instead of being pushed apart', async () => {
    const lib = await loadRapier();
    // post right through the level bar
    const a = pendulum({ driven: true, post: [60, 200] });
    const dyn = new Dynamics(lib, a, await massProperties(a), new Map([['hinge', 0]]));
    expect(dyn.restOverlaps()).toBe(1);
    for (let i = 0; i < 240; i++) dyn.step(1 / 240, () => 90);
    expect(Math.abs(dyn.jointAngles().get('hinge')!)).toBeLessThan(2);
    expect(dyn.touching()).toEqual([]);
    dyn.dispose();
  });

  it('a joint driven into its stop comes back when the actuator commands it back', async () => {
    const lib = await loadRapier();
    const a = pendulum({ driven: true });
    a.joints[0].limits = [-30, 30];
    const dyn = new Dynamics(lib, a, await massProperties(a), new Map([['hinge', 0]]));
    dyn.step(1, () => 0); // servo at 0° commands −90°: the bar goes down onto its −30° stop, gravity leaning on it
    expect(dyn.jointAngles().get('hinge')!).toBeLessThan(-25);
    dyn.step(1, () => 90); // back to level
    expect(Math.abs(dyn.jointAngles().get('hinge')!)).toBeLessThan(2);
    dyn.dispose();
  });

  it('the dexterous hand holds its pose: light knuckles between a heavy palm and the fingers do not give way', async () => {
    const lib = await loadRapier();
    const asm = TEMPLATES.find((t) => t.id === 'dexterous-hand')!.project.assembly!;
    const devices = new Set(asm.joints.flatMap((j) => (j.drive && 'device' in j.drive ? [j.drive.device] : [])));
    const mid = (d: string) => (devices.has(d) ? 90 : undefined);
    const dyn = new Dynamics(lib, asm, await massProperties(asm), jointValues(asm, mid));
    dyn.step(1, mid);
    // every servo-driven joint within 3° of its command (the static gravity loads are all below 10 % of stall)
    for (const t of dyn.tracking(mid)) expect(Math.abs(t.commanded - t.actual), t.device).toBeLessThan(3);
    expect(dyn.touching()).toEqual([]);
    dyn.dispose();
  });
});

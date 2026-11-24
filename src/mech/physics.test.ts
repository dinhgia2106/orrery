import { describe, expect, it } from 'vitest';
import dexHex from '../../public/examples/dexterous-hand.hex?raw';
import dexWristHex from '../../public/examples/dexterous-hand-wrist.hex?raw';
import { LabSimulation } from '../lab/labsim';
import { TEMPLATES, cloneProject } from '../lab/project';
import { parseIntelHex } from '../sim/hex';
import { Servo } from '../sim/parts';
import { jointValues, type Assembly } from './assembly';
import { gravityLoads, interference, massProperties } from './physics';

/** A base, and a 100 × 10 × 10 mm PLA bar on a revolute joint about Z, driven 1:1 by servo1 (servo 90° = bar horizontal). */
function bar(massG?: number): Assembly {
  return {
    format: 'orrery.assembly',
    version: 1,
    name: 'bar',
    units: 'mm',
    placement: [0, 0, 0],
    links: [
      { id: 'base', shape: { box: [40, 10, 40] }, material: 'PLA', make: 'print' },
      { id: 'bar', shape: { box: [100, 10, 10] }, position: [50, 0, 0], material: 'PLA', make: 'print', ...(massG !== undefined ? { massG } : {}) },
    ],
    joints: [{ id: 'j', type: 'revolute', parent: 'base', child: 'bar', position: [0, 100, 0], axis: [0, 0, 1], drive: { device: 'servo1', from: [0, 180], to: [-90, 90] } }],
    mounts: [{ device: 'servo1', kind: 'servo', link: 'base', position: [0, 0, 0] }],
  };
}

describe('mass properties', () => {
  it('integrates volume and centre of mass from the printable solid', async () => {
    const props = await massProperties(bar());
    const b = props.get('bar')!;
    expect(b.massG).toBeCloseTo(10 * 1.24, 6); // 10 cm³ of PLA at 1.24 g/cm³
    expect(b.com[0]).toBeCloseTo(50, 6);
    expect(b.com[1]).toBeCloseTo(0, 6);
  });

  it('a hole removes its mass; unknown materials ask for massG', async () => {
    const a = bar();
    a.links[1].features = [{ hole: { d: 5, position: [80, 0, 0] } }];
    a.links[0].material = 'wood';
    const props = await massProperties(a);
    expect(props.get('bar')!.massG).toBeLessThan(12.4);
    expect(props.get('bar')!.com[0]).toBeLessThan(50); // material removed at x = 80 moves the centre back
    expect(props.get('base')!.how).toBe('unknown');
  });
});

describe('gravity loads', () => {
  it('a horizontal bar pulls down with m·g·50 mm; upright it pulls nothing', async () => {
    const a = bar();
    const props = await massProperties(a);
    const flat = gravityLoads(a, props, jointValues(a, () => 90));
    expect(flat.joints.get('j')).toBeCloseTo(-12.4 * 50, 3); // gf·mm, clockwise about +Z
    expect(flat.actuators.get('servo1')!.torqueKgfCm).toBeCloseTo((-12.4 * 50) / 10_000, 6);
    const up = gravityLoads(a, props, jointValues(a, () => 180)); // joint +90°: bar points up
    expect(Math.abs(up.joints.get('j')!)).toBeLessThan(1e-6);
  });

  it('a transmission scales the load: a 2:1 reduction halves the torque at the servo', async () => {
    const a = bar();
    a.joints[0].drive = { device: 'servo1', from: [0, 180], to: [-45, 45] }; // 0.5 joint degree per servo degree
    const props = await massProperties(a);
    const l = gravityLoads(a, props, jointValues(a, () => 90));
    expect(l.actuators.get('servo1')!.torqueKgfCm).toBeCloseTo((-12.4 * 50 * 0.5) / 10_000, 6);
  });
});

describe('servo under load (linear torque–speed between the datasheet points)', () => {
  it('slows with an opposing load and stops at the stall torque', () => {
    const run = (load: number) => {
      const s = new Servo('s', 'D9');
      s.loadKgfCm = load;
      s.onPin('D9', true, 0);
      s.onPin('D9', false, 0.0024); // 2400 µs → target 180°
      s.update(0.05);
      return s;
    };
    expect(run(0).angle).toBeCloseTo(120, 5); // 600 °/s × 50 ms from 90°
    expect(run(-0.9).angle).toBeCloseTo(105, 5); // half the stall torque against it: half the speed
    const stalled = run(-1.8);
    expect(stalled.angle).toBe(90);
    expect(stalled.warnings.join()).toMatch(/stalled/);
    expect(run(+1).angle).toBeCloseTo(120, 5); // a helping load does not exceed the no-load speed
  });

  it('a bar too heavy for an SG90 cannot be lifted in the full simulation', async () => {
    const a = bar(400); // 400 g at 50 mm = 2 kgf·cm > 1.8
    const props = await massProperties(a);
    const servo = new Servo('servo1', 'D9');
    servo.angle = 90;
    servo.target = 180;
    servo.loadKgfCm = gravityLoads(a, props, jointValues(a, () => servo.angle)).actuators.get('servo1')!.torqueKgfCm;
    servo.update(0.1);
    expect(servo.angle).toBe(90);
    servo.target = 0; // lowering goes with gravity
    servo.update(0.2);
    expect(servo.angle).toBeLessThan(90);
  });
});

describe('interference', () => {
  it('reports overlapping parts with the overlap volume, and ignores parts joined by a joint', async () => {
    const a = bar();
    a.links.push({ id: 'block', shape: { box: [20, 20, 20] }, material: 'PLA', make: 'print' });
    a.joints.push({ id: 'block_fix', type: 'fixed', parent: 'base', child: 'block', position: [80, 100, 0] }); // sits on the bar's far end
    const clashes = await interference(a, jointValues(a, () => 90));
    expect(clashes).toHaveLength(1);
    expect(clashes[0]).toMatchObject({ a: 'bar', b: 'block' });
    expect(clashes[0].volumeMm3).toBeCloseTo(20 * 10 * 10, 0); // x 70–90, y 95–105, z −5–5
    const swung = await interference(a, jointValues(a, () => 180)); // bar up, out of the block
    expect(swung).toEqual([]);
  });
});

describe('the dexterous hand under gravity', () => {
  it('carries real loads on every actuator and none of the SG90s stalls through the gestures', async () => {
    const p = cloneProject(TEMPLATES.find((t) => t.id === 'dexterous-hand')!.project);
    const sim = new LabSimulation(p, { uno: parseIntelHex(dexHex), uno2: parseIntelHex(dexWristHex) });
    sim.setMechanics(p.assembly, await massProperties(p.assembly!));
    sim.step(5.5); // open → fist → point
    const snap = sim.snapshot();
    expect(snap.actuators).toHaveLength(17);
    expect(snap.mechanismMassG).toBeGreaterThan(100);
    for (const a of snap.actuators) expect(Math.abs(a.torqueKgfCm)).toBeLessThan(a.limitKgfCm);
    expect(snap.checks.filter((c) => /stalled/.test(c.msg))).toEqual([]);
  });
});

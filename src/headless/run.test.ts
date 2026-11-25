import { describe, expect, it } from 'vitest';
import robotArmHex from '../../public/examples/robot-arm.hex?raw';
import serialEchoHex from '../../public/examples/serial-echo.hex?raw';
import serialPingHex from '../../public/examples/serial-ping.hex?raw';
import servoSweepHex from '../../public/examples/servo-sweep.hex?raw';
import type { Assembly } from '../mech/assembly';
import { TEMPLATES, cloneProject, type Project } from '../lab/project';
import { runProject } from './run';

const template = (id: string) => cloneProject(TEMPLATES.find((t) => t.id === id)!.project);

/** A base and a 100 × 10 × 10 mm PLA bar hinged about Z, driven 1:1 by servo1 (servo 90° = bar horizontal). */
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

const sweepWith = (asm: Assembly): Project => ({ ...template('servo-sweep'), assembly: asm });

describe('headless runs', () => {
  it('servo sweep: samples the horn over its range and reports a clean bench', async () => {
    const r = await runProject(template('servo-sweep'), { seconds: 3, firmware: { uno: servoSweepHex } });
    const angles = r.samples.map((s) => s.devices.servo1.angle as number);
    expect(Math.min(...angles)).toBeLessThan(5);
    expect(Math.max(...angles)).toBeGreaterThan(175);
    expect(r.samples.length).toBe(61); // t = 0, 0.05 … 3
    expect(r.simulatedSec).toBe(3);
    expect(r.checks.filter((c) => c.level === 'error')).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.mechanics).toBeUndefined();
  });

  it('robot arm: timed pot and button inputs reach the firmware', async () => {
    const r = await runProject(template('robot-arm'), {
      seconds: 1.5,
      firmware: { uno: robotArmHex },
      mechanics: 'off',
      inputs: [
        { t: 0, pot: 'pot1', value: 0 },
        { t: 0.5, pot: 'pot1', value: 1 },
        { t: 1, press: 'button1', holdMs: 50 },
      ],
    });
    const at = (t: number) => r.samples.find((s) => Math.abs(s.t - t) < 1e-6)!;
    expect(at(0.5).devices.servo1.angle).toBeLessThan(2);
    expect(at(1).devices.servo1.angle).toBeGreaterThan(178);
    expect(at(1).devices.stepper1.angle).toBeCloseTo(90, 1);
    expect(r.final.stepper1.angle).toBeCloseTo(0, 1);
    expect(r.serial.uno).toContain('elbow -> 0');
  });

  it('a wiring mistake makes the run fail with the check that explains it', async () => {
    const p = template('servo-sweep');
    p.wires = p.wires.filter((w) => w.a !== 'servo1.GND');
    const r = await runProject(p, { seconds: 0.5, firmware: { uno: servoSweepHex } });
    expect(r.checks.map((c) => c.msg).join('\n')).toMatch(/GND is not common with uno's GND/);
    expect(r.final.servo1.angle).toBe(90);
  });

  it('unknown input targets are reported, not ignored', async () => {
    const r = await runProject(template('servo-sweep'), { seconds: 0.1, inputs: [{ t: 0, press: 'button9' }] });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/no button "button9"/);
  });

  it('two boards: serial output per board', async () => {
    const r = await runProject(template('two-boards'), { seconds: 1.2, firmware: { uno: serialPingHex, uno2: serialEchoHex } });
    expect(r.serial.uno2).toContain('got: ping 1');
    expect(r.ok).toBe(true);
  });
});

describe('headless mechanics', () => {
  it('static: a light bar passes, joint angles follow the servo', async () => {
    const r = await runProject(sweepWith(bar()), { seconds: 2, firmware: { uno: servoSweepHex } });
    expect(r.assembly?.ok).toBe(true);
    expect(r.mechanics?.mode).toBe('static');
    expect(r.mechanics!.totalMassG).toBeGreaterThan(12); // the 12.4 g bar plus the mounted SG90
    const s = r.samples[r.samples.length - 1];
    expect(s.joints!.j).toBeCloseTo((s.devices.servo1.angle as number) - 90, 1);
    expect(r.mechanics!.actuators[0].peakShare).toBeGreaterThan(0);
    expect(r.mechanics!.actuators[0].peakShare).toBeLessThan(1);
    expect(r.ok).toBe(true);
  });

  it('static: a bar too heavy for the SG90 fails with the load', async () => {
    const r = await runProject(sweepWith(bar(400)), { seconds: 0.5, firmware: { uno: servoSweepHex } }); // 2 kgf·cm > 1.8
    expect(r.ok).toBe(false);
    expect(r.mechanics!.actuators[0].peakShare).toBeGreaterThan(1);
    expect(r.problems.join('\n')).toMatch(/servo1 is loaded to \d+% of its 1\.8 kgf·cm limit/);
  });

  it('static: a part in the swing path is reported as a clash', async () => {
    const a = bar();
    a.links.push({ id: 'block', shape: { box: [20, 20, 20] }, material: 'PLA', make: 'print' });
    a.joints.push({ id: 'block_fix', type: 'fixed', parent: 'base', child: 'block', position: [80, 100, 0] }); // on the bar when horizontal
    const r = await runProject(sweepWith(a), { seconds: 0.1, clashChecks: 1 }); // blank chip: the servo stays at 90°
    expect(r.mechanics!.clashes).toHaveLength(1);
    expect(r.mechanics!.clashes[0]).toMatchObject({ a: 'bar', b: 'block' });
    expect(r.ok).toBe(false);
  });

  it('an invalid assembly is reported and the electronics still run', async () => {
    const a = bar();
    a.joints[0].parent = 'nowhere';
    const r = await runProject(sweepWith(a), { seconds: 0.2, firmware: { uno: servoSweepHex } });
    expect(r.assembly?.ok).toBe(false);
    expect(r.problems.some((p) => p.startsWith('assembly: '))).toBe(true);
    expect(r.mechanics).toBeUndefined();
  });

  it('dynamic: joints track the servo and a dropped ball comes to rest on the bench', async () => {
    const r = await runProject(sweepWith(bar()), {
      seconds: 1.5,
      firmware: { uno: servoSweepHex },
      mechanics: 'dynamic',
      inputs: [{ t: 0, drop: 'ball', sizeMm: 30, at: [300, 60, 0] }],
    });
    const d = r.mechanics!.dynamics!;
    expect(d.tracking.map((x) => x.device)).toEqual(['servo1']);
    expect(d.tracking[0].finalErrorDeg).toBeLessThan(10);
    expect(d.loose).toHaveLength(1);
    expect(d.loose[0].p[1]).toBeCloseTo(15, 0); // radius above y = 0
  });
});

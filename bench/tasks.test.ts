import { describe, expect, it } from 'vitest';
import blinkHex from '../public/examples/blink.hex?raw';
import serialEchoHex from '../public/examples/serial-echo.hex?raw';
import servoSweepHex from '../public/examples/servo-sweep.hex?raw';
import { solutions } from './solutions';
import { TASKS, gradeTask, type Grade } from './tasks';

const SOL = solutions();
const task = (id: string) => TASKS.find((t) => t.id === id)!;
const failed = (g: Grade) => g.criteria.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe('benchmark tasks', () => {
  it('every task has a reference solution, and ids are unique', () => {
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
    expect(Object.keys(SOL).sort()).toEqual(TASKS.map((t) => t.id).sort());
  });

  for (const t of TASKS) {
    it(`${t.id}: the reference solution passes`, async () => {
      const s = SOL[t.id];
      const g = await gradeTask(t, s.project, s.firmware);
      expect(failed(g)).toEqual([]);
      expect(g.pass).toBe(true);
    });
  }
});

describe('graders fail wrong answers', () => {
  it('blink-2hz: the 1 Hz Blink example fails', async () => {
    const g = await gradeTask(task('blink-2hz'), SOL['blink-2hz'].project, { uno: blinkHex });
    expect(g.pass).toBe(false);
    expect(failed(g).join('\n')).toMatch(/250 ms/);
  });

  it('button-toggle-led: an LED without its resistor is over-driven', async () => {
    const p = clone(SOL['button-toggle-led'].project);
    p.devices = p.devices.filter((d) => d.id !== 'r1');
    p.wires = p.wires.filter((w) => !w.a.startsWith('r1.') && !w.b.startsWith('r1.'));
    p.wires.push({ id: 'direct', a: 'uno.D8', b: 'led1.A', color: '#000' });
    const g = await gradeTask(task('button-toggle-led'), p, SOL['button-toggle-led'].firmware);
    expect(g.pass).toBe(false);
    expect(failed(g)[0]).toMatch(/clean bench/);
  });

  it('button-toggle-led: no button means the tester cannot operate it', async () => {
    const p = clone(SOL['button-toggle-led'].project);
    p.devices = p.devices.filter((d) => d.kind !== 'button');
    p.wires = p.wires.filter((w) => !w.a.startsWith('button1.'));
    const g = await gradeTask(task('button-toggle-led'), p, SOL['button-toggle-led'].firmware);
    expect(failed(g)).toEqual(['the tester can operate it: there is no button on the bench']);
  });

  it('pot-servo: a free-running sweep ignores the pot', async () => {
    const g = await gradeTask(task('pot-servo'), SOL['pot-servo'].project, { uno: servoSweepHex });
    expect(g.pass).toBe(false);
  });

  it('pot-servo: the pot wired the other way round still passes (either direction is allowed)', async () => {
    const p = clone(SOL['pot-servo'].project);
    p.wires = p.wires.map((w) => (w.a === 'pot1.1' ? { ...w, a: 'pot1.3' } : w.a === 'pot1.3' ? { ...w, a: 'pot1.1' } : w));
    expect((await gradeTask(task('pot-servo'), p, SOL['pot-servo'].firmware)).pass).toBe(true);
  });

  it('serial-pong: an echo that answers every line ("got: …") fails', async () => {
    const g = await gradeTask(task('serial-pong'), SOL['serial-pong'].project, { uno: serialEchoHex });
    expect(g.pass).toBe(false);
  });

  it('stepper-one-rev: without the VMOT capacitor it fails', async () => {
    const p = clone(SOL['stepper-one-rev'].project);
    p.devices = p.devices.filter((d) => d.id !== 'cap1');
    p.wires = p.wires.filter((w) => !w.a.startsWith('cap1.'));
    const g = await gradeTask(task('stepper-one-rev'), p, SOL['stepper-one-rev'].firmware);
    expect(failed(g).join('\n')).toMatch(/µF/);
  });

  it('two-board-relay: without the TX → RX wire the second board never hears the button', async () => {
    const p = clone(SOL['two-board-relay'].project);
    p.wires = p.wires.filter((w) => w.a !== 'uno.D1');
    const g = await gradeTask(task('two-board-relay'), p, SOL['two-board-relay'].firmware);
    expect(failed(g).join('\n')).toMatch(/toggles L per press/);
  });

  it('arm-lift: a drive that only reaches 45° fails', async () => {
    const p = clone(SOL['arm-lift'].project);
    p.assembly!.joints[0].drive = { device: 'servo1', from: [0, 180], to: [-45, 45] };
    const g = await gradeTask(task('arm-lift'), p, SOL['arm-lift'].firmware);
    expect(failed(g).join('\n')).toMatch(/straight up/);
  });

  it('heavy-lift: driving the weight directly (no reduction) overloads the SG90', async () => {
    const p = clone(SOL['heavy-lift'].project);
    p.assembly!.joints[0].drive = { device: 'servo1', from: [0, 180], to: [0, 180] };
    const g = await gradeTask(task('heavy-lift'), p, SOL['heavy-lift'].firmware);
    expect(g.pass).toBe(false);
    expect(failed(g).join('\n')).toMatch(/stall torque|loaded to/);
  });

  it('a project that is not one fails cleanly', async () => {
    const g = await gradeTask(task('blink-2hz'), { version: 3 }, {});
    expect(g.pass).toBe(false);
  });
});

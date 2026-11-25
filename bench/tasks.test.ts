import { describe, expect, it } from 'vitest';
import blinkHex from '../public/examples/blink.hex?raw';
import serialEchoHex from '../public/examples/serial-echo.hex?raw';
import servoSweepHex from '../public/examples/servo-sweep.hex?raw';
import type { Project } from '../src/lab/project';
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

/** Grade a task's reference bench after `edit`, with the firmware of `fw` (another task's, by default its own). */
async function wrong(id: string, edit: (p: Project) => void = () => {}, fw: Record<string, string> = SOL[id].firmware): Promise<string> {
  const p = clone(SOL[id].project);
  edit(p);
  const g = await gradeTask(task(id), p, fw);
  expect(g.pass).toBe(false);
  return failed(g).join('\n');
}
const dropWires = (p: Project, prefix: string) => (p.wires = p.wires.filter((w) => !w.a.startsWith(prefix) && !w.b.startsWith(prefix)));
const rewire = (p: Project, from: string, to: string) => (p.wires = p.wires.map((w) => ({ ...w, a: w.a === from ? to : w.a, b: w.b === from ? to : w.b })));

describe('graders fail wrong answers to the other tasks', () => {
  it('sos-morse: a plain 2 Hz blink', async () => expect(await wrong('sos-morse', undefined, SOL['blink-2hz'].firmware)).toMatch(/marks/));

  it('pwm-fade: an LED that blinks instead of fading', async () => {
    expect(await wrong('pwm-fade', (p) => rewire(p, 'uno.D9', 'uno.D13'), { uno: blinkHex })).toMatch(/fades/);
  });

  it('traffic-light: yellow and green swapped', async () => {
    const out = await wrong('traffic-light', (p) => {
      for (const d of p.devices) d.id = d.id === 'green' ? 'yellow' : d.id === 'yellow' ? 'green' : d.id;
      p.wires = p.wires.map((w) => ({ ...w, a: w.a.replace(/^green\./, 'G.').replace(/^yellow\./, 'green.').replace(/^G\./, 'yellow.'), b: w.b.replace(/^green\./, 'G.').replace(/^yellow\./, 'green.').replace(/^G\./, 'yellow.') }));
    });
    expect(out).toMatch(/want green, lit yellow/);
  });

  it('button-counter-serial: firmware that prints something else', async () => {
    expect(await wrong('button-counter-serial', undefined, { uno: SOL['two-board-relay'].firmware.uno })).toMatch(/count: 1/);
  });

  it('long-press: a plain toggle treats the long press as a press', async () => {
    expect(await wrong('long-press', undefined, SOL['button-toggle-led'].firmware)).toMatch(/held 0.5 s/); // it toggles on the press itself
  });

  it('pot-threshold: the pot wired the other way round inverts the wiper', async () => {
    expect(await wrong('pot-threshold', (p) => (rewire(p, 'pot1.1', 'pot1.X'), rewire(p, 'pot1.3', 'pot1.1'), rewire(p, 'pot1.X', 'pot1.3')))).toMatch(/wiper/);
  });

  it('serial-led-command: answering in the wrong protocol', async () => {
    expect(await wrong('serial-led-command', undefined, SOL['serial-pong'].firmware)).toMatch(/answers ok/);
  });

  it('serial-servo-command: a free-running sweep', async () => {
    expect(await wrong('serial-servo-command', undefined, { uno: servoSweepHex })).toMatch(/angle 30/);
  });

  it('serial-adc-read: no answer to "read"', async () => {
    expect(await wrong('serial-adc-read', undefined, SOL['serial-pong'].firmware)).toMatch(/256, 767, 1023/);
  });

  it('led-from-psu: 220 Ω drives the LED far past 10 mA', async () => {
    expect(await wrong('led-from-psu', (p) => (p.devices.find((d) => d.id === 'r1')!.props.ohms = 220))).toMatch(/10 ± 1 mA/);
  });

  it('divider-adc: the right ratio with resistors under 1 kΩ', async () => {
    const out = await wrong('divider-adc', (p) => {
      p.devices.find((d) => d.id === 'r1')!.props.ohms = 300;
      p.devices.find((d) => d.id === 'r2')!.props.ohms = 200;
    });
    expect(out).toMatch(/at least 1 kΩ/);
    expect(out).not.toMatch(/2000 ± 50 mV/);
  });

  it('two-servos-mirror: servos on the Uno 5 V pin instead of the supply', async () => {
    expect(await wrong('two-servos-mirror', (p) => rewire(p, 'psu1.+', 'uno.5V'))).toMatch(/bench supply/);
  });

  it('servo-slow-sweep: a sweep at the servo’s own speed', async () => {
    expect(await wrong('servo-slow-sweep', undefined, { uno: servoSweepHex })).toMatch(/60°\/s/);
  });

  it('six-servo-supply: six servos on the Uno 5 V pin', async () => {
    expect(await wrong('six-servo-supply', (p) => rewire(p, 'psu1.+', 'uno.5V'))).toMatch(/bench supply/);
  });

  it('stepper-pot-position: no VMOT capacitor', async () => {
    expect(await wrong('stepper-pot-position', (p) => ((p.devices = p.devices.filter((d) => d.id !== 'cap1')), dropWires(p, 'cap1.')))).toMatch(/Pololu/);
  });

  it('stepper-button-jog: a full revolution instead of quarter turns', async () => {
    expect(await wrong('stepper-button-jog', undefined, SOL['stepper-one-rev'].firmware)).toMatch(/270°/);
  });

  it('stepper-microstep: MS pins left open makes 3200 full steps', async () => {
    expect(await wrong('stepper-microstep', (p) => dropWires(p, 'a49881.MS'))).toMatch(/1\/16 microstep mode/);
  });

  it('stepper-speed: one revolution and stop', async () => {
    expect(await wrong('stepper-speed', undefined, SOL['stepper-one-rev'].firmware)).toMatch(/360°\/s/);
  });

  it('two-board-servo: without the TX → RX wire the servo never hears the pot', async () => {
    expect(await wrong('two-board-servo', (p) => (p.wires = p.wires.filter((w) => w.a !== 'uno.D1')))).toMatch(/servo1 at/);
  });

  it('gripper-close: the second finger not coupled to the first', async () => {
    expect(await wrong('gripper-close', (p) => delete p.assembly!.joints[1].drive)).toMatch(/closed after a press/);
  });

  it('pan-tilt: tilt mapped to 90° instead of 60°', async () => {
    expect(await wrong('pan-tilt', (p) => (p.assembly!.joints[1].drive = { device: 'servo2', from: [0, 180], to: [0, 90] }))).toMatch(/tilted 60°/);
  });

  it('arm-two-joint-reach: the elbow servo mapped the wrong way round', async () => {
    expect(await wrong('arm-two-joint-reach', (p) => (p.assembly!.joints[1].drive = { device: 'servo2', from: [0, 180], to: [-90, 90] }))).toMatch(/120 mm out/);
  });
});

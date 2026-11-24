import { describe, expect, it } from 'vitest';
import blinkHex from '../../public/examples/blink.hex?raw';
import robotArmHex from '../../public/examples/robot-arm.hex?raw';
import servoSweepHex from '../../public/examples/servo-sweep.hex?raw';
import stepperHex from '../../public/examples/stepper-a4988.hex?raw';
import { parseIntelHex } from '../sim/hex';
import { solve } from './circuit';
import { LabSimulation } from './labsim';
import { TEMPLATES, blankProject, cloneProject, parseProject, projectFromHash, projectToHash, type Project } from './project';

const HEX: Record<string, string> = { blink: blinkHex, 'robot-arm': robotArmHex, 'servo-sweep': servoSweepHex, 'stepper-a4988': stepperHex };
const template = (id: string) => cloneProject(TEMPLATES.find((t) => t.id === id)!.project);
const run = (p: Project, hex: string) => new LabSimulation(p, parseIntelHex(HEX[hex]));
const msgs = (sim: LabSimulation) => sim.snapshot().checks.map((c) => c.msg).join('\n');

describe('circuit solver', () => {
  it('solves a divider and reports the current a source delivers', () => {
    // nets: 0 = GND, 1 = 5 V, 2 = mid
    const sol = solve(3, 0, [
      { kind: 'V', p: 1, n: 0, v: 5 },
      { kind: 'G', a: 1, b: 2, g: 1 / 1000 },
      { kind: 'G', a: 2, b: 0, g: 1 / 1000 },
    ]);
    expect(sol.volts[2]).toBeCloseTo(2.5, 6);
    expect(sol.sourceAmps.get(0)).toBeCloseTo(0.0025, 9);
    expect(Array.from(sol.driven)).toEqual([1, 1, 1]);
  });

  it('marks nets with no path to ground as floating', () => {
    const sol = solve(3, 0, [{ kind: 'G', a: 1, b: 2, g: 1e-3 }]);
    expect(sol.driven[1]).toBe(0);
  });
});

describe('templates run their real firmware against the wired circuit', () => {
  it('blink toggles the on-board L LED', () => {
    const sim = run(template('blink'), 'blink');
    sim.step(0.25);
    expect(sim.builtinLed()).toBe(1);
    sim.step(0.5);
    expect(sim.builtinLed()).toBe(0);
  });

  it('servo sweep moves the horn across its range with no wiring problems', () => {
    const sim = run(template('servo-sweep'), 'servo-sweep');
    const s = sim.servos.get('servo1')!;
    let min = 180;
    let max = 0;
    for (let i = 0; i < 300; i++) {
      sim.step(0.01);
      min = Math.min(min, s.angle);
      max = Math.max(max, s.angle);
    }
    expect(min).toBeLessThan(5);
    expect(max).toBeGreaterThan(175);
    expect(sim.snapshot().checks.filter((c) => !c.msg.startsWith('5 V rail'))).toEqual([]);
  });

  it('stepper template turns half a revolution through the A4988', () => {
    const sim = run(template('stepper-a4988'), 'stepper-a4988');
    sim.step(0.35);
    expect(sim.motorAngle('stepper1')).toBeCloseTo(180, 5);
    expect(sim.snapshot().checks).toEqual([]);
  });

  it('robot arm: pot through the solved divider steers the servo, the button toggles the elbow', () => {
    const sim = run(template('robot-arm'), 'robot-arm');
    sim.pots.get('pot1')!.set(0);
    sim.step(0.5);
    expect(sim.servos.get('servo1')!.angle).toBeLessThan(2);
    expect(sim.motorAngle('stepper1')).toBeCloseTo(90, 5);
    sim.pots.get('pot1')!.set(1);
    sim.step(0.5);
    expect(sim.servos.get('servo1')!.angle).toBeGreaterThan(178);
    const b = sim.buttons.get('button1')!;
    b.press(true);
    b.press(false, 0.05);
    sim.step(0.4);
    expect(sim.motorAngle('stepper1')).toBeCloseTo(0, 5);
    expect(sim.snapshot().serial).toContain('elbow -> 0');
  });
});

describe('wiring mistakes behave like the bench', () => {
  it('without the RST–SLP jumper the A4988 ignores every step', () => {
    const p = template('stepper-a4988');
    p.wires = p.wires.filter((w) => !(w.a === 'a49881.RST' && w.b === 'a49881.SLP'));
    const sim = run(p, 'stepper-a4988');
    sim.step(0.35);
    expect(sim.motorAngle('stepper1')).toBe(0);
    expect(msgs(sim)).toMatch(/RST is floating/);
  });

  it('a coil split across 1A/2A makes the motor buzz instead of turning', () => {
    const p = template('stepper-a4988');
    for (const w of p.wires) {
      if (w.b === 'stepper1.A-') w.b = 'stepper1.B+';
      else if (w.b === 'stepper1.B+') w.b = 'stepper1.A-';
    }
    const sim = run(p, 'stepper-a4988');
    sim.step(0.35);
    expect(sim.motorAngle('stepper1')).toBe(0);
    expect(msgs(sim)).toMatch(/must each be one motor coil/);
  });

  it('swapping one coil reverses the direction', () => {
    const p = template('stepper-a4988');
    for (const w of p.wires) {
      if (w.b === 'stepper1.A+') w.b = 'stepper1.A-';
      else if (w.b === 'stepper1.A-') w.b = 'stepper1.A+';
    }
    const sim = run(p, 'stepper-a4988');
    sim.step(0.35);
    expect(sim.motorAngle('stepper1')).toBeCloseTo(-180, 5);
  });

  it('no motor supply: the driver does nothing and says why', () => {
    const p = template('stepper-a4988');
    p.devices.find((d) => d.id === 'psu1')!.props.volts = 5;
    const sim = run(p, 'stepper-a4988');
    sim.step(0.35);
    expect(sim.motorAngle('stepper1')).toBe(0);
    expect(msgs(sim)).toMatch(/VMOT is 5\.0 V/);
  });

  it('a servo without a common ground ignores its signal', () => {
    const p = template('servo-sweep');
    p.wires = p.wires.filter((w) => w.a !== 'servo1.GND');
    const sim = run(p, 'servo-sweep');
    sim.step(1);
    expect(sim.servos.get('servo1')!.angle).toBe(90);
    expect(msgs(sim)).toMatch(/not common with the Uno's GND/);
  });

  it('an LED straight from a pin to GND is flagged as over-current; with 220 Ω it is fine', () => {
    const p = template('blink');
    p.devices.push({ id: 'led1', kind: 'led', x: 0, y: 0, props: {} });
    p.wires.push({ id: 'a', a: 'led1.A', b: 'uno.D13', color: '#f00' }, { id: 'b', a: 'led1.K', b: 'uno.GND1', color: '#000' });
    const bare = run(p, 'blink');
    bare.step(0.25);
    expect(msgs(bare)).toMatch(/above the ATmega328P's 40 mA|above its 30 mA maximum/);

    p.devices.push({ id: 'r1', kind: 'resistor', x: 0, y: 0, props: { ohms: 220 } });
    p.wires = [
      { id: 'a', a: 'led1.A', b: 'r1.1', color: '#f00' },
      { id: 'c', a: 'r1.2', b: 'uno.D13', color: '#f00' },
      { id: 'b', a: 'led1.K', b: 'uno.GND1', color: '#000' },
    ];
    const ok = run(p, 'blink');
    ok.step(0.25);
    const ma = Number(ok.snapshot().devices.led1.mA);
    expect(ma).toBeGreaterThan(8); // (VOH − VF) / (220 Ω + source + LED) ≈ 11 mA
    expect(ma).toBeLessThan(14);
    expect(ok.snapshot().checks).toEqual([]);
  });

  it('an input wired to an open contact floats', () => {
    const p = template('blink');
    p.devices.push({ id: 'button1', kind: 'button', x: 0, y: 0, props: {} });
    p.wires.push({ id: 'a', a: 'button1.1', b: 'uno.D2', color: '#ff0' }, { id: 'b', a: 'button1.3', b: 'uno.GND1', color: '#000' });
    const sim = run(p, 'blink'); // blink never enables INPUT_PULLUP on D2
    sim.step(0.05);
    expect(msgs(sim)).toMatch(/D2 is an input but nothing drives it/);
  });

  it('wiring a button across one contact pair is caught', () => {
    const p = template('blink');
    p.devices.push({ id: 'button1', kind: 'button', x: 0, y: 0, props: {} });
    p.wires.push({ id: 'a', a: 'button1.1', b: 'uno.D2', color: '#ff0' }, { id: 'b', a: 'button1.2', b: 'uno.GND1', color: '#000' });
    const sim = run(p, 'blink');
    sim.step(0.01);
    expect(msgs(sim)).toMatch(/only one contact pair is wired/);
  });

  it('shorting 5V to GND stops the circuit', () => {
    const p = template('blink');
    p.wires.push({ id: 'x', a: 'uno.5V', b: 'uno.GND2', color: '#f00' });
    const sim = run(p, 'blink');
    expect(sim.fatal[0].msg).toMatch(/Short circuit/);
  });
});

describe('project files', () => {
  it('round-trips through a share link and rejects junk', () => {
    const p = template('robot-arm');
    expect(projectFromHash(projectToHash(p))).toEqual(parseProject(JSON.stringify(p)));
    expect(() => parseProject('{"version":2}')).toThrow();
    const q = parseProject(JSON.stringify({ ...p, wires: [...p.wires, { a: 'ghost.1', b: 'uno.D2' }] }));
    expect(q.wires).toHaveLength(p.wires.length);
  });
});

describe('benches without a board, or with a blank one', () => {
  const ledBench = (volts: number): Project => ({
    version: 1,
    name: 'LED on a bench supply',
    devices: [
      { id: 'psu1', kind: 'psu', x: 0, y: 0, props: { volts } },
      { id: 'r1', kind: 'resistor', x: 0, y: 0, props: { ohms: 330 } },
      { id: 'led1', kind: 'led', x: 0, y: 0, props: {} },
    ],
    wires: [
      { id: 'a', a: 'psu1.+', b: 'r1.1', color: '#f00' },
      { id: 'b', a: 'r1.2', b: 'led1.A', color: '#f00' },
      { id: 'c', a: 'led1.K', b: 'psu1.-', color: '#000' },
    ],
    code: '',
  });

  it('a bench supply lights an LED with no Arduino at all', () => {
    const sim = new LabSimulation(ledBench(5));
    expect(sim.board).toBeNull();
    sim.step(0.05);
    const ma = Number(sim.snapshot().devices.led1.mA);
    expect(ma).toBeCloseTo(((5 - 1.9) / (330 + 10)) * 1000, 1); // (V − VF) / (R + LED series R)
    expect(sim.snapshot().checks).toEqual([]);
    expect(sim.time).toBeCloseTo(0.05, 6);
  });

  it('an isolated second supply circuit is powered too', () => {
    const p = ledBench(5);
    p.devices.push(
      { id: 'psu2', kind: 'psu', x: 0, y: 0, props: { volts: 12 } },
      { id: 'r2', kind: 'resistor', x: 0, y: 0, props: { ohms: 1000 } },
      { id: 'led2', kind: 'led', x: 0, y: 0, props: {} },
    );
    p.wires.push(
      { id: 'd', a: 'psu2.+', b: 'r2.1', color: '#f00' },
      { id: 'e', a: 'r2.2', b: 'led2.A', color: '#f00' },
      { id: 'f', a: 'led2.K', b: 'psu2.-', color: '#000' },
    );
    const sim = new LabSimulation(p);
    sim.step(0.05);
    expect(Number(sim.snapshot().devices.led2.mA)).toBeCloseTo(((12 - 1.9) / 1010) * 1000, 1);
  });

  it('parts with nothing to power them say so; an empty bench is fine', () => {
    const p = ledBench(5);
    p.devices = p.devices.filter((d) => d.kind !== 'psu');
    p.wires = p.wires.filter((w) => !w.a.startsWith('psu1') && !w.b.startsWith('psu1'));
    expect(new LabSimulation(p).fatal[0].msg).toMatch(/Nothing powers this bench/);
    const empty = new LabSimulation(blankProject());
    empty.step(0.01);
    expect(empty.snapshot().checks).toEqual([]);
  });

  it('a board with nothing uploaded still powers the circuit, and its pins float', () => {
    const p = template('blink');
    p.devices.push({ id: 'r1', kind: 'resistor', x: 0, y: 0, props: { ohms: 330 } }, { id: 'led1', kind: 'led', x: 0, y: 0, props: {} }, { id: 'button1', kind: 'button', x: 0, y: 0, props: {} });
    p.wires.push(
      { id: 'a', a: 'uno.5V', b: 'r1.1', color: '#f00' },
      { id: 'b', a: 'r1.2', b: 'led1.A', color: '#f00' },
      { id: 'c', a: 'led1.K', b: 'uno.GND1', color: '#000' },
      { id: 'd', a: 'button1.1', b: 'uno.D2', color: '#ff0' },
      { id: 'e', a: 'button1.3', b: 'uno.GND2', color: '#000' },
    );
    const sim = new LabSimulation(p); // BLANK_PROGRAM
    sim.step(0.05);
    expect(Number(sim.snapshot().devices.led1.mA)).toBeGreaterThan(8);
    expect(msgs(sim)).toMatch(/D2 is an input but nothing drives it/);
    expect(sim.builtinLed()).toBe(0);
  });

  it('projects without a board survive save and load', () => {
    expect(blankProject().devices).toEqual([]);
    expect(parseProject(JSON.stringify(ledBench(9))).devices.map((d) => d.kind)).toEqual(['psu', 'resistor', 'led']);
  });
});

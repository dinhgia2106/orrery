// Runs the arduino-cli builds in public/examples/ (see scripts/build-examples.mjs) through the simulator,
// with the same wiring the UI uses for each example.
import { describe, expect, it } from 'vitest';
import robotArmHex from '../../public/examples/robot-arm.hex?raw';
import servoSweepHex from '../../public/examples/servo-sweep.hex?raw';
import stepperHex from '../../public/examples/stepper-a4988.hex?raw';
import { Simulation, type PartSpec } from './engine';
import { parseIntelHex } from './hex';
import type { Button, Potentiometer, Servo, StepperA4988 } from './parts';

const HEX: Record<string, string> = {
  'robot-arm': robotArmHex,
  'servo-sweep': servoSweepHex,
  'stepper-a4988': stepperHex,
};

function load(name: string): Uint16Array {
  return parseIntelHex(HEX[name]);
}

const ARM: PartSpec[] = [
  { id: 'base', type: 'servo', pin: 'D9' },
  { id: 'elbow', type: 'stepper', step: 'D3', dir: 'D4' },
  { id: 'home', type: 'button', pin: 'D2' },
  { id: 'knob', type: 'pot', pin: 'A0' },
  { id: 'busy', type: 'led', pin: 'D13' },
];

describe('compiled examples', () => {
  it('servo-sweep swings the servo across its full range', () => {
    const sim = new Simulation(load('servo-sweep'), [
      { id: 'base', type: 'servo', pin: 'D9' },
      { id: 'led13', type: 'led', pin: 'D13' },
    ]);
    const servo = sim.part<Servo>('base')!;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 300; i++) {
      sim.step(0.01);
      min = Math.min(min, servo.angle);
      max = Math.max(max, servo.angle);
    }
    expect(min).toBeLessThan(5);
    expect(max).toBeGreaterThan(175);
    expect(sim.snapshot().serial).toContain('servo sweep');
    expect(servo.warnings).toEqual([]);
  });

  it('stepper-a4988 turns half a revolution forward, then back', () => {
    const sim = new Simulation(load('stepper-a4988'), [{ id: 'elbow', type: 'stepper', step: 'D3', dir: 'D4' }]);
    const m = sim.part<StepperA4988>('elbow')!;
    sim.step(0.35); // 100 steps at ~2 ms each, then a 300 ms pause
    expect(m.position).toBe(100);
    expect(m.angle).toBeCloseTo(180, 5);
    sim.step(0.5);
    expect(m.position).toBe(0);
    expect(m.missed).toBe(0);
    expect(sim.snapshot().serial).toContain('back 180 deg');
  });

  it('robot-arm: the pot steers the base servo and the button toggles the elbow', () => {
    const sim = new Simulation(load('robot-arm'), ARM);
    const base = sim.part<Servo>('base')!;
    const elbow = sim.part<StepperA4988>('elbow')!;
    const knob = sim.part<Potentiometer>('knob')!;
    const button = sim.part<Button>('home')!;

    knob.set(0);
    sim.step(0.5);
    expect(base.angle).toBeLessThan(2);
    expect(elbow.position).toBe(50); // starts by moving to 90°
    expect(sim.snapshot().parts.busy.on).toBe(false);

    knob.set(1);
    sim.step(0.5);
    expect(base.angle).toBeGreaterThan(178);

    button.press(true);
    sim.step(0.05);
    button.press(false);
    sim.step(0.3);
    expect(elbow.position).toBe(0);
    expect(elbow.missed).toBe(0);
    expect(sim.snapshot().serial).toContain('elbow -> 0');

    // a UI click: press and release arrive before the simulation advances at all
    button.press(true);
    button.press(false);
    sim.step(0.3);
    expect(button.pressed).toBe(false);
    expect(elbow.position).toBe(50);
    expect(sim.snapshot().serial).toContain('elbow -> 50');
  });
});

import { describe, expect, it } from 'vitest';
import { ArduinoUno, pinLocation } from './board';
import { BLINK_ASM_WORDS, blinkProgram } from './demos';
import { Simulation } from './engine';
import { parseIntelHex, toIntelHex } from './hex';
import { Servo, StepperA4988 } from './parts';

describe('Intel HEX', () => {
  it('round-trips program words', () => {
    const prog = parseIntelHex(toIntelHex(BLINK_ASM_WORDS));
    expect(Array.from(prog.slice(0, BLINK_ASM_WORDS.length))).toEqual(BLINK_ASM_WORDS);
  });
});

describe('pin mapping', () => {
  it('maps Uno pins to ATmega328P ports', () => {
    expect(pinLocation('D2')).toEqual({ port: 'D', bit: 2 });
    expect(pinLocation('D13')).toEqual({ port: 'B', bit: 5 });
    expect(pinLocation('A3')).toEqual({ port: 'C', bit: 3 });
  });
});

describe('ArduinoUno running real machine code', () => {
  it('blinks D13 about once per second', () => {
    const board = new ArduinoUno(blinkProgram());
    const edges: number[] = [];
    board.onPin((pin, high, t) => pin === 'D13' && high && edges.push(t));
    board.run(2.2);
    expect(edges.length).toBeGreaterThanOrEqual(2);
    const period = edges[1] - edges[0];
    expect(period).toBeGreaterThan(0.8);
    expect(period).toBeLessThan(1.3);
  });

  it('drives an LED part through the simulation', () => {
    const sim = new Simulation(blinkProgram(), [{ id: 'led', type: 'led', pin: 'D13' }]);
    sim.step(0.3);
    expect(sim.snapshot().parts.led.on).toBe(true);
    sim.step(0.5);
    expect(sim.snapshot().parts.led.on).toBe(false);
  });
});

describe('Servo', () => {
  const pulse = (s: Servo, t: number, us: number) => {
    s.onPin('D9', true, t);
    s.onPin('D9', false, t + us / 1e6);
  };

  it('maps pulse width to angle and moves at finite speed', () => {
    const s = new Servo('s', 'D9');
    pulse(s, 0, 2400);
    expect(s.target).toBeCloseTo(180, 5);
    s.update(0.05); // 600 deg/s * 0.05 s = 30 deg from 90
    expect(s.angle).toBeCloseTo(120, 5);
    s.update(1);
    expect(s.angle).toBeCloseTo(180, 5);
  });

  it('warns when driven by fast PWM instead of servo pulses', () => {
    const s = new Servo('s', 'D9');
    pulse(s, 0, 1000);
    pulse(s, 0.002, 1000);
    expect(s.warnings.join()).toMatch(/analogWrite/);
  });
});

describe('Stepper behind A4988', () => {
  it('counts steps by direction and loses steps that come too fast', () => {
    const m = new StepperA4988('m', 'D3', 'D4', { stepsPerRev: 200, microsteps: 1, maxStepsPerSec: 1000 });
    m.onPin('D4', true, 0);
    for (let i = 0; i < 50; i++) m.onPin('D3', true, i * 0.002);
    expect(m.position).toBe(50);
    expect(m.angle).toBeCloseTo(90, 5);
    m.onPin('D4', false, 1);
    m.onPin('D3', true, 1.0);
    m.onPin('D3', true, 1.0001); // 10 kHz: too fast
    expect(m.position).toBe(49);
    expect(m.missed).toBe(1);
  });
});

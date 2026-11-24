import { describe, expect, it } from 'vitest';
import { ArduinoUno, pinLocation } from './board';
import { BLINK_ASM_WORDS, blinkProgram } from './demos';
import { billOfMaterials } from '../lab/bom';
import { TEMPLATES, cloneProject } from '../lab/project';
import { parseIntelHex, toIntelHex } from './hex';
import { Button, Led, Servo, StepperA4988 } from './parts';

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
    const step = (t: number) => {
      m.onPin('D3', true, t);
      m.onPin('D3', false, t + 5e-6);
    };
    m.onPin('D4', true, 0);
    for (let i = 0; i < 50; i++) step(0.001 + i * 0.002);
    expect(m.position).toBe(50);
    expect(m.angle).toBeCloseTo(90, 5);
    m.onPin('D4', false, 0.999);
    step(1.0);
    step(1.0001); // 10 kHz: too fast
    expect(m.position).toBe(49);
    expect(m.missed).toBe(1);
    expect(m.warnings).toHaveLength(1);
  });

  it('checks the A4988 timing limits from the Allegro datasheet', () => {
    const m = new StepperA4988('m', 'D3', 'D4');
    m.onPin('D3', true, 0);
    m.onPin('D3', false, 0.5e-6); // 0.5 µs high < 1 µs
    m.onPin('D4', true, 0.01);
    m.onPin('D3', true, 0.01 + 100e-9); // DIR 100 ns before STEP < 200 ns
    expect(m.warnings.join('\n')).toMatch(/at least 1 µs/);
    expect(m.warnings.join('\n')).toMatch(/200 ns setup/);
  });
});

describe('Button (Omron B3F)', () => {
  it('bounces for a few ms after a press, inside the 5 ms datasheet limit', () => {
    const levels: [number, boolean][] = [];
    let t = 0;
    const b = new Button('b', 'D2');
    b.attach({ setDigitalInput: (_p, high) => levels.push([t, high]), setAnalogInput: () => {} });
    b.press(true);
    for (t = 0.001; t < 0.02; t += 0.001) b.update(t);
    const edges = levels.slice(1); // skip attach
    expect(edges.length).toBeGreaterThan(2);
    expect(edges[edges.length - 1][1]).toBe(false); // ends pressed (LOW)
    expect(edges[edges.length - 1][0]).toBeLessThanOrEqual(0.005);
  });
});

describe('bill of materials and rail figures', () => {
  it('lists a real part number for every device on the bench', () => {
    const bom = billOfMaterials(cloneProject(TEMPLATES.find((t) => t.id === 'robot-arm')!.project));
    expect(bom.map((l) => l.item.mpn)).toEqual(['A000066', 'SG90', '1182', 'SY42STH38-1684A', '—', '—', 'B3F-1000', 'PTV09A-2020F-B103']);
    expect(bom.find((l) => l.item.key === 'uno')!.refs).toEqual(['U1']);
    expect(bom.every((l) => l.item.datasheet.url.startsWith('https://'))).toBe(true);
  });

  it('derives LED current from the resistor and warns above the WP7113ID maximum', () => {
    expect(new Led('a', 'D7', undefined, false, 330).onCurrentMa()).toBeCloseTo(9.39, 2); // (5 − 1.9) / 330
    expect(new Led('b', 'D13', undefined, true).onCurrentMa()).toBe(5); // ≤ 5 V / 1 kΩ
    expect(new Led('c', 'D7', undefined, false, 47).warnings.join()).toMatch(/30 mA maximum/);
  });
});

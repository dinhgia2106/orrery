import type { PinName } from './board';

/** Everything a part can tell the UI about itself. */
export interface PartState {
  [key: string]: number | boolean | string;
}

export interface PartContext {
  setDigitalInput(pin: PinName, high: boolean): void;
  setAnalogInput(pin: PinName, volts: number): void;
}

export interface Part {
  readonly id: string;
  readonly type: string;
  /** Pins this part listens to (outputs of the board). */
  readonly inputs: PinName[];
  onPin?(pin: PinName, high: boolean, t: number): void;
  /** Advance internal dynamics to simulated time t (seconds). */
  update?(t: number): void;
  attach?(ctx: PartContext): void;
  state(): PartState;
  /** Problems that would break or damage the real build. */
  warnings: string[];
}

function warnOnce(list: string[], msg: string): void {
  if (!list.includes(msg)) list.push(msg);
}

/** LED on a digital pin. Brightness follows the PWM duty cycle. */
export class Led implements Part {
  readonly type = 'led';
  readonly inputs: PinName[];
  warnings: string[] = [];
  private high = false;
  private since = 0;
  private window: { high: number; total: number; start: number } = { high: 0, total: 0, start: 0 };
  private duty = 0;

  constructor(readonly id: string, readonly pin: PinName, readonly color = '#ff5a4f') {
    this.inputs = [pin];
  }

  onPin(_pin: PinName, high: boolean, t: number): void {
    if (this.high) this.window.high += t - this.since;
    this.high = high;
    this.since = t;
  }

  update(t: number): void {
    const w = this.window;
    if (this.high) w.high += t - this.since;
    this.since = t;
    w.total = t - w.start;
    if (w.total >= 0.02) {
      this.duty = w.high / w.total;
      this.window = { high: 0, total: 0, start: t };
    }
  }

  state(): PartState {
    return { on: this.high, brightness: Math.round(this.duty * 100) / 100 };
  }
}

/**
 * Hobby servo (SG90-like) on a PWM pin. The angle comes from the pulse width, as on the real part:
 * 544–2400 µs maps to 0–180° (Arduino Servo library defaults), and the horn moves at a finite speed.
 */
export class Servo implements Part {
  readonly type = 'servo';
  readonly inputs: PinName[];
  warnings: string[] = [];
  angle = 90;
  target = 90;
  pulseUs = 0;
  private rise = -1;
  private lastT = 0;

  constructor(
    readonly id: string,
    readonly pin: PinName,
    readonly opts = { minUs: 544, maxUs: 2400, degPerSec: 600, stallTorqueKgCm: 1.8 },
  ) {
    this.inputs = [pin];
  }

  onPin(_pin: PinName, high: boolean, t: number): void {
    if (high) {
      if (this.rise >= 0) {
        const period = t - this.rise;
        if (period < 0.0025) warnOnce(this.warnings, `Servo ${this.id}: pulse period ${(period * 1000).toFixed(2)} ms is far below 20 ms — the pin is probably driven by analogWrite(), not the Servo library.`);
      }
      this.rise = t;
      return;
    }
    if (this.rise < 0) return;
    this.pulseUs = (t - this.rise) * 1e6;
    const { minUs, maxUs } = this.opts;
    if (this.pulseUs < 400 || this.pulseUs > 2600) {
      warnOnce(this.warnings, `Servo ${this.id}: pulse ${this.pulseUs.toFixed(0)} µs is outside the 400–2600 µs a hobby servo accepts.`);
      return;
    }
    const clamped = Math.min(maxUs, Math.max(minUs, this.pulseUs));
    this.target = ((clamped - minUs) / (maxUs - minUs)) * 180;
  }

  update(t: number): void {
    const dt = Math.max(0, t - this.lastT);
    this.lastT = t;
    const step = this.opts.degPerSec * dt;
    const diff = this.target - this.angle;
    this.angle += Math.abs(diff) <= step ? diff : Math.sign(diff) * step;
  }

  state(): PartState {
    return { angle: Math.round(this.angle * 10) / 10, target: Math.round(this.target * 10) / 10, pulseUs: Math.round(this.pulseUs) };
  }
}

/**
 * Stepper motor behind an A4988-style STEP/DIR driver. Every rising edge on STEP moves one
 * (micro)step in the direction set by DIR. Pulses faster than the motor can follow are lost,
 * as a real stepper stalls instead of speeding up.
 */
export class StepperA4988 implements Part {
  readonly type = 'stepper';
  readonly inputs: PinName[];
  warnings: string[] = [];
  position = 0; // in microsteps
  missed = 0;
  private dirHigh = false;
  private lastStep = -1;

  constructor(
    readonly id: string,
    readonly stepPin: PinName,
    readonly dirPin: PinName,
    readonly opts = { stepsPerRev: 200, microsteps: 1, maxStepsPerSec: 1000 },
  ) {
    this.inputs = [stepPin, dirPin];
  }

  onPin(pin: PinName, high: boolean, t: number): void {
    if (pin === this.dirPin) {
      this.dirHigh = high;
      return;
    }
    if (!high) return;
    const minGap = 1 / (this.opts.maxStepsPerSec * this.opts.microsteps);
    if (this.lastStep >= 0 && t - this.lastStep < minGap) {
      this.missed++;
      warnOnce(this.warnings, `Stepper ${this.id}: STEP pulses faster than ${this.opts.maxStepsPerSec} full steps/s — a real motor would stall and lose steps.`);
      return;
    }
    this.lastStep = t;
    this.position += this.dirHigh ? 1 : -1;
  }

  get angle(): number {
    return (this.position / (this.opts.stepsPerRev * this.opts.microsteps)) * 360;
  }

  state(): PartState {
    return { steps: this.position, angle: Math.round(this.angle * 10) / 10, missed: this.missed };
  }
}

/** Push button between a pin and GND, read with INPUT_PULLUP (pressed = LOW). */
export class Button implements Part {
  readonly type = 'button';
  readonly inputs: PinName[] = [];
  warnings: string[] = [];
  pressed = false;
  private ctx?: PartContext;

  constructor(readonly id: string, readonly pin: PinName) {}

  attach(ctx: PartContext): void {
    this.ctx = ctx;
    ctx.setDigitalInput(this.pin, true);
  }

  press(down: boolean): void {
    this.pressed = down;
    this.ctx?.setDigitalInput(this.pin, !down);
  }

  state(): PartState {
    return { pressed: this.pressed };
  }
}

/** Potentiometer as a voltage divider on an analog pin. */
export class Potentiometer implements Part {
  readonly type = 'pot';
  readonly inputs: PinName[] = [];
  warnings: string[] = [];
  value = 0.5; // wiper position 0..1
  private ctx?: PartContext;

  constructor(readonly id: string, readonly pin: PinName) {}

  attach(ctx: PartContext): void {
    this.ctx = ctx;
    this.set(this.value);
  }

  set(value: number): void {
    this.value = Math.min(1, Math.max(0, value));
    this.ctx?.setAnalogInput(this.pin, this.value * 5);
  }

  state(): PartState {
    return { value: Math.round(this.value * 100) / 100, volts: Math.round(this.value * 500) / 100 };
  }
}

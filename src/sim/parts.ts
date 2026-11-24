import type { PinName } from './board';
import { SPEC } from './catalog';

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
  /** Current drawn from the board's 5 V rail right now, in mA, and whether that figure is an approximation. */
  railMa?(): { ma: number; approx: boolean };
  /** Problems that would break or damage the real build. */
  warnings: string[];
}

function warnOnce(list: string[], msg: string): void {
  if (!list.includes(msg)) list.push(msg);
}

/**
 * LED on a digital pin. Brightness follows the PWM duty cycle.
 * `builtin` is the Uno's own "L" LED on D13 (yellow, 1 kΩ, LMV358 buffer — UNO R3 schematic);
 * otherwise it is a Kingbright WP7113ID with a series resistor.
 */
export class Led implements Part {
  readonly type = 'led';
  readonly inputs: PinName[];
  warnings: string[] = [];
  private high = false;
  private since = 0;
  private window: { high: number; total: number; start: number } = { high: 0, total: 0, start: 0 };
  private duty = 0;

  constructor(
    readonly id: string,
    readonly pin: PinName,
    readonly color = '#ff5a4f',
    readonly builtin = false,
    readonly resistorOhms = 330,
  ) {
    this.inputs = [pin];
    const { vfTyp, ifMaxMa } = SPEC.wp7113id;
    if (!builtin && this.onCurrentMa() > ifMaxMa) {
      warnOnce(
        this.warnings,
        `LED ${id}: ${resistorOhms} Ω gives ~${this.onCurrentMa().toFixed(0)} mA, above the ${ifMaxMa} mA maximum of a WP7113ID — use at least ${Math.ceil(((5 - vfTyp) / ifMaxMa) * 1000)} Ω.`,
      );
    }
  }

  /** Current while lit, from Ohm's law: built-in ≤ 5 V / 1 kΩ (upper bound), external (5 V − VF typ) / R. */
  onCurrentMa(): number {
    if (this.builtin) return (5 / SPEC.uno.builtinLedSeriesOhms) * 1000;
    return ((5 - SPEC.wp7113id.vfTyp) / Math.max(1, this.resistorOhms)) * 1000;
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

  railMa() {
    return { ma: Math.max(this.duty, this.high ? 1 : 0) * this.onCurrentMa(), approx: this.builtin };
  }

  state(): PartState {
    return { on: this.high, brightness: Math.round(this.duty * 100) / 100 };
  }
}

/**
 * TowerPro SG90 micro servo. The angle comes from the pulse width, as on the real part:
 * 544–2400 µs maps to 0–180° (Arduino Servo library limits, Servo.h), and the horn turns at
 * 60° per 0.1 s (TowerPro, 4.8 V).
 */
export class Servo implements Part {
  readonly type = 'servo';
  readonly inputs: PinName[];
  warnings: string[] = [];
  angle = 90;
  target = 90;
  pulseUs = 0;
  /** Whether the servo can follow its signal (powered within range, ground shared with the signal source). */
  gate: () => boolean = () => true;
  private rise = -1;
  private lastT = 0;

  constructor(
    readonly id: string,
    readonly pin: PinName,
    readonly opts = {
      minUs: SPEC.servoLib.minUs,
      maxUs: SPEC.servoLib.maxUs,
      degPerSec: 60 / SPEC.sg90.secPer60Deg,
      stallTorqueKgCm: SPEC.sg90.stallTorqueKgfCm,
    },
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
    if (!this.gate()) return;
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

  get moving(): boolean {
    return Math.abs(this.target - this.angle) > 0.5;
  }

  /** TowerPro publishes no current figure; see SPEC.sg90.movingMaApprox. */
  railMa() {
    return { ma: this.moving ? SPEC.sg90.movingMaApprox : 0, approx: true };
  }

  state(): PartState {
    return { angle: Math.round(this.angle * 10) / 10, target: Math.round(this.target * 10) / 10, pulseUs: Math.round(this.pulseUs) };
  }
}

/**
 * NEMA 17 stepper (SY42STH47-1206A, 200 steps/rev) behind a Pololu A4988 carrier. Every rising edge on
 * STEP moves one (micro)step in the direction set by DIR. The driver's timing limits from the Allegro
 * datasheet are checked (STEP ≥ 1 µs high and low, DIR set up ≥ 200 ns before STEP). Pulses faster than
 * the motor can follow are lost, as a real stepper stalls instead of speeding up (that rate is approximate).
 */
export class StepperA4988 implements Part {
  readonly type = 'stepper';
  readonly inputs: PinName[];
  warnings: string[] = [];
  position = 0; // in full steps (fractional in microstep modes)
  missed = 0;
  /** Steps the driver ignored because it was in reset, asleep, disabled or unpowered. */
  ignored = 0;
  /** +1, or −1 when one coil is wired the other way round (the motor turns backwards). */
  dirSign = 1;
  /** Whether a STEP edge moves the shaft right now (driver powered, awake, enabled, coils paired). */
  gate: () => boolean = () => true;
  private dirHigh = false;
  private dirChangedAt = -1;
  private stepHigh = false;
  private stepRose = -1;
  private stepFell = -1;
  private lastStep = -1;

  constructor(
    readonly id: string,
    readonly stepPin: PinName,
    readonly dirPin: PinName,
    readonly opts = { stepsPerRev: SPEC.nema17.stepsPerRev, microsteps: 1, maxStepsPerSec: SPEC.nema17.maxStepsPerSecApprox },
  ) {
    this.inputs = [stepPin, dirPin];
  }

  onPin(pin: PinName, high: boolean, t: number): void {
    if (pin === this.dirPin) {
      if (high !== this.dirHigh) this.dirChangedAt = t;
      this.dirHigh = high;
      return;
    }
    if (high === this.stepHigh) return;
    this.stepHigh = high;
    const { stepHighMinUs, stepLowMinUs, setupNs } = SPEC.a4988;
    if (!high) {
      if (this.stepRose >= 0 && (t - this.stepRose) * 1e6 < stepHighMinUs) {
        warnOnce(this.warnings, `Stepper ${this.id}: STEP high for ${((t - this.stepRose) * 1e6).toFixed(2)} µs — the A4988 needs at least ${stepHighMinUs} µs.`);
      }
      this.stepFell = t;
      return;
    }
    this.stepRose = t;
    if (this.stepFell >= 0 && (t - this.stepFell) * 1e6 < stepLowMinUs) {
      warnOnce(this.warnings, `Stepper ${this.id}: STEP low for ${((t - this.stepFell) * 1e6).toFixed(2)} µs — the A4988 needs at least ${stepLowMinUs} µs.`);
    }
    if (this.dirChangedAt >= 0 && (t - this.dirChangedAt) * 1e9 < setupNs) {
      warnOnce(this.warnings, `Stepper ${this.id}: DIR changed ${((t - this.dirChangedAt) * 1e9).toFixed(0)} ns before STEP — the A4988 needs ${setupNs} ns setup time.`);
    }
    if (!this.gate()) {
      this.ignored++;
      return;
    }
    const minGap = 1 / (this.opts.maxStepsPerSec * this.opts.microsteps);
    if (this.lastStep >= 0 && t - this.lastStep < minGap) {
      this.missed++;
      warnOnce(this.warnings, `Stepper ${this.id}: STEP pulses faster than ~${this.opts.maxStepsPerSec} full steps/s (approx.) — a real motor would stall and lose steps.`);
      return;
    }
    this.lastStep = t;
    this.position += ((this.dirHigh ? 1 : -1) * this.dirSign) / this.opts.microsteps;
  }

  get angle(): number {
    return (this.position / this.opts.stepsPerRev) * 360;
  }

  /** The carrier's logic side runs from the Uno 5 V (IDD ≤ 8 mA); the motor has its own 8–35 V supply. */
  railMa() {
    return { ma: SPEC.a4988.logicMaMax, approx: false };
  }

  state(): PartState {
    return { steps: Math.round(this.position * 100) / 100, angle: Math.round(this.angle * 10) / 10, missed: this.missed, ignored: this.ignored };
  }
}

/**
 * Omron B3F-1000 tactile switch between a pin and GND, read with INPUT_PULLUP (pressed = LOW).
 * Contacts bounce: the datasheet allows up to 5 ms. The exact bounce pattern is not specified, so the
 * model toggles the contact every millisecond for 4 ms after each press and release (an approximation
 * inside the 5 ms limit) — enough to expose firmware that does not debounce.
 * A release is held back until simulated time has passed the press by `holdSec` and the press bounce has
 * settled, so a quick UI click whose press and release land between two frames still reaches the firmware.
 */
export class Button implements Part {
  static readonly BOUNCE_EDGES = 4; // 1 ms apart, all inside the 5 ms datasheet limit
  readonly type = 'button';
  readonly inputs: PinName[] = [];
  warnings: string[] = [];
  pressed = false;
  private ctx?: PartContext;
  private now = 0; // simulated time of the last update
  private downAt = 0;
  private releaseAfter?: number; // pending release: keep the contact closed for this many simulated seconds
  private bounce: { at: number; high: boolean }[] = [];

  constructor(readonly id: string, readonly pin: PinName, readonly bounces = true) {}

  attach(ctx: PartContext): void {
    this.ctx = ctx;
    ctx.setDigitalInput(this.pin, true);
  }

  /** Press (`down`) or release the button; a release keeps the contact closed for at least `holdSec` of simulated time. */
  press(down: boolean, holdSec = 0): void {
    if (down) {
      this.pressed = true;
      this.downAt = this.now;
      this.releaseAfter = undefined;
      this.settle(false);
    } else if (this.pressed) {
      this.releaseAfter = holdSec;
      this.tryRelease();
    }
  }

  update(t: number): void {
    this.now = t;
    while (this.bounce.length && this.bounce[0].at <= t) {
      this.ctx?.setDigitalInput(this.pin, this.bounce.shift()!.high);
    }
    this.tryRelease();
  }

  /** Drive the pin to `high`; if the contacts bounce, chatter for a few ms and end at `high`. */
  private settle(high: boolean): void {
    this.ctx?.setDigitalInput(this.pin, high);
    this.bounce = [];
    if (!this.bounces) return;
    for (let i = 1; i <= Button.BOUNCE_EDGES; i++) {
      this.bounce.push({ at: this.now + i * 0.001 - 1e-9, high: i % 2 === 0 ? high : !high });
    }
  }

  private tryRelease(): void {
    if (this.releaseAfter === undefined || this.bounce.length) return;
    if (this.now <= this.downAt || this.now - this.downAt < this.releaseAfter) return;
    this.pressed = false;
    this.releaseAfter = undefined;
    this.settle(true);
  }

  state(): PartState {
    return { pressed: this.pressed };
  }
}

/** Bourns PTV09A 10 kΩ linear potentiometer as a voltage divider between 5 V and GND on an analog pin. */
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

  /** 5 V across the 10 kΩ track: 0.5 mA, whatever the wiper position. */
  railMa() {
    return { ma: (5 / SPEC.ptv09.ohms) * 1000, approx: false };
  }

  state(): PartState {
    return { value: Math.round(this.value * 100) / 100, volts: Math.round(this.value * 500) / 100 };
  }
}

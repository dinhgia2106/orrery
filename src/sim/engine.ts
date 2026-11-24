import { ArduinoUno, type PinName } from './board';
import { Button, Led, Potentiometer, Servo, StepperA4988, type Part, type PartState } from './parts';

export type PartSpec =
  | { id: string; type: 'led'; pin: PinName; color?: string }
  | { id: string; type: 'servo'; pin: PinName }
  | { id: string; type: 'stepper'; step: PinName; dir: PinName; stepsPerRev?: number; microsteps?: number }
  | { id: string; type: 'button'; pin: PinName }
  | { id: string; type: 'pot'; pin: PinName };

export function createPart(spec: PartSpec): Part {
  switch (spec.type) {
    case 'led':
      return new Led(spec.id, spec.pin, spec.color);
    case 'servo':
      return new Servo(spec.id, spec.pin);
    case 'stepper':
      return new StepperA4988(spec.id, spec.step, spec.dir, {
        stepsPerRev: spec.stepsPerRev ?? 200,
        microsteps: spec.microsteps ?? 1,
        maxStepsPerSec: 1000,
      });
    case 'button':
      return new Button(spec.id, spec.pin);
    case 'pot':
      return new Potentiometer(spec.id, spec.pin);
  }
}

/** Approximate current each part draws from the Uno's 5 V rail, in mA. */
function railCurrentMa(part: Part): number {
  if (part instanceof Led) return (part.state().brightness as number) * 15 || (part.state().on ? 15 : 0);
  if (part instanceof Servo) return Math.abs(part.target - part.angle) > 0.5 ? 250 : 10;
  if (part instanceof Potentiometer) return 0.5;
  return 0; // steppers run from the driver's own motor supply
}

const BOARD_MA = 50;
const USB_LIMIT_MA = 500;
const SLICE = 0.001; // seconds of simulated time between part updates

export interface Snapshot {
  time: number;
  parts: Record<string, PartState & { type: string }>;
  pins: Record<string, boolean>;
  railMa: number;
  warnings: string[];
  serial: string;
}

/** One board, its firmware and the parts wired to it. */
export class Simulation {
  readonly board: ArduinoUno;
  readonly parts: Part[];
  private serial = '';
  private peakRailMa = BOARD_MA;
  private readonly simWarnings: string[] = [];

  constructor(program: Uint16Array, specs: PartSpec[]) {
    this.board = new ArduinoUno(program);
    this.parts = specs.map(createPart);
    const byPin = new Map<PinName, Part[]>();
    for (const part of this.parts) {
      for (const pin of part.inputs) byPin.set(pin, [...(byPin.get(pin) ?? []), part]);
      part.attach?.({
        setDigitalInput: (pin, high) => this.board.setDigitalInput(pin, high),
        setAnalogInput: (pin, volts) => this.board.setAnalogInput(pin as 'A0', volts),
      });
    }
    this.board.onPin((pin, high, t) => byPin.get(pin)?.forEach((p) => p.onPin?.(pin, high, t)));
    this.board.onSerial((ch) => {
      this.serial = (this.serial + ch).slice(-8000);
    });
  }

  part<T extends Part>(id: string): T | undefined {
    return this.parts.find((p) => p.id === id) as T | undefined;
  }

  /** Advance simulated time, updating part dynamics every millisecond. */
  step(seconds: number): void {
    let left = seconds;
    while (left > 1e-9) {
      const dt = Math.min(SLICE, left);
      this.board.run(dt);
      const t = this.board.time;
      for (const p of this.parts) p.update?.(t);
      this.checkPower();
      left -= dt;
    }
  }

  private checkPower(): void {
    const ma = BOARD_MA + this.parts.reduce((sum, p) => sum + railCurrentMa(p), 0);
    this.peakRailMa = Math.max(this.peakRailMa, ma);
    if (ma > USB_LIMIT_MA) {
      const msg = `5 V rail draws ~${Math.round(ma)} mA, above the ${USB_LIMIT_MA} mA a USB port supplies — power servos from a separate supply with a common ground.`;
      const i = this.simWarnings.findIndex((w) => w.startsWith('5 V rail'));
      if (i < 0) this.simWarnings.push(msg);
      else if (ma >= this.peakRailMa) this.simWarnings[i] = msg;
    }
  }

  snapshot(): Snapshot {
    const parts: Snapshot['parts'] = {};
    for (const p of this.parts) parts[p.id] = { type: p.type, ...p.state() };
    const pins: Record<string, boolean> = {};
    for (const p of this.parts) for (const pin of p.inputs) pins[pin] = this.board.isHigh(pin);
    return {
      time: this.board.time,
      parts,
      pins,
      railMa: Math.round(this.peakRailMa),
      warnings: [...this.simWarnings, ...this.parts.flatMap((p) => p.warnings)],
      serial: this.serial,
    };
  }
}

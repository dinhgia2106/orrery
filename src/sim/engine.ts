import { ArduinoUno, type PinName } from './board';
import { CATALOG, SPEC, type CatalogItem } from './catalog';
import { Button, Led, Potentiometer, Servo, StepperA4988, type Part, type PartState } from './parts';

export type PartSpec =
  /** `builtin`: the Uno's own D13 "L" LED. Otherwise an external 5 mm LED with `resistorOhms` in series (default 330 Ω). */
  | { id: string; type: 'led'; pin: PinName; color?: string; builtin?: boolean; resistorOhms?: number }
  | { id: string; type: 'servo'; pin: PinName }
  | { id: string; type: 'stepper'; step: PinName; dir: PinName; stepsPerRev?: number; microsteps?: number }
  | { id: string; type: 'button'; pin: PinName; bounce?: boolean }
  | { id: string; type: 'pot'; pin: PinName };

export function createPart(spec: PartSpec): Part {
  switch (spec.type) {
    case 'led':
      return new Led(spec.id, spec.pin, spec.color, spec.builtin ?? false, spec.resistorOhms ?? 330);
    case 'servo':
      return new Servo(spec.id, spec.pin);
    case 'stepper':
      return new StepperA4988(spec.id, spec.step, spec.dir, {
        stepsPerRev: spec.stepsPerRev ?? SPEC.nema17.stepsPerRev,
        microsteps: spec.microsteps ?? 1,
        maxStepsPerSec: SPEC.nema17.maxStepsPerSecApprox,
      });
    case 'button':
      return new Button(spec.id, spec.pin, spec.bounce ?? true);
    case 'pot':
      return new Potentiometer(spec.id, spec.pin);
  }
}

export interface BomLine {
  qty: number;
  item: CatalogItem;
  /** Part ids in the project that use this item. */
  usedBy: string[];
}

/** What to buy for a set of parts: the Uno plus one catalog item per part (built-in LEDs come with the board). */
export function billOfMaterials(specs: PartSpec[]): BomLine[] {
  const lines = new Map<string, BomLine>();
  const add = (key: string, id: string) => {
    const line = lines.get(key) ?? { qty: 0, item: CATALOG[key], usedBy: [] };
    line.qty++;
    line.usedBy.push(id);
    lines.set(key, line);
  };
  add('uno', 'board');
  for (const s of specs) {
    if (s.type === 'led' && !s.builtin) add('wp7113id', s.id);
    if (s.type === 'servo') add('sg90', s.id);
    if (s.type === 'stepper') {
      add('a4988', s.id);
      add('nema17', s.id);
    }
    if (s.type === 'button') add('b3f', s.id);
    if (s.type === 'pot') add('ptv09', s.id);
  }
  return [...lines.values()];
}

const BOARD_MA = SPEC.uno.boardMaApprox;
const USB_LIMIT_MA = SPEC.uno.usbFuseMa;
const SLICE = 0.001; // seconds of simulated time between part updates

export interface Snapshot {
  time: number;
  parts: Record<string, PartState & { type: string }>;
  pins: Record<string, boolean>;
  railMa: number;
  /** True when any figure in the rail total is an approximation rather than a datasheet value. */
  railApprox: boolean;
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
    const ma = BOARD_MA + this.parts.reduce((sum, p) => sum + (p.railMa?.().ma ?? 0), 0);
    this.peakRailMa = Math.max(this.peakRailMa, ma);
    if (ma > USB_LIMIT_MA) {
      const msg = `5 V rail draws ~${Math.round(ma)} mA (approx.), above the ${USB_LIMIT_MA} mA USB fuse on the Uno — power servos from a separate 5 V supply with a common ground.`;
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
      railApprox: true, // the board's own draw is an estimate (the Uno datasheet leaves it blank)
      warnings: [...this.simWarnings, ...this.parts.flatMap((p) => p.warnings)],
      serial: this.serial,
    };
  }
}

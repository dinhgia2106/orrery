// Runs a lab project: real firmware on the Uno, the bench circuit solved from the user's wiring, and the
// device models driven from it. Wiring mistakes surface as checks, the way they would on a real bench.
import { ANALOG_PINS, ArduinoUno, DIGITAL_PINS, pinLocation, type PinName } from '../sim/board';
import { SPEC } from '../sim/catalog';
import { Button, Potentiometer, Servo, StepperA4988, type PartState } from '../sim/parts';
import { PinState } from 'avr8js';
import { Netlist, solve, type Element, type Solution } from './circuit';
import type { Device, Project } from './project';

export interface Check {
  level: 'error' | 'warn';
  msg: string;
  device?: string;
}

export interface LabSnapshot {
  time: number;
  devices: Record<string, PartState>;
  pins: Record<string, { mode: string; volts: number | null }>;
  railMa: number;
  checks: Check[];
  serial: string;
}

const IO_PINS: PinName[] = [...DIGITAL_PINS, ...ANALOG_PINS];
const VCC = 5;
const M = SPEC.m328;
const R_SOURCE = (VCC - M.vohAt20mA) / 0.02; // ~45 Ω: VOH 4.1 V at 20 mA
const R_SINK = M.volAt20mA / 0.02; // ~40 Ω: VOL 0.8 V at 20 mA
const R_PULLUP = (M.pullupMinOhms + M.pullupMaxOhms) / 2; // approx: midpoint of the 20–50 kΩ range
const LED_RS = 10; // approx: LED series resistance, not in the WP7113ID datasheet
/** approx: Pololu does not publish these; inferred from its minimal wiring (EN unconnected, RST tied to SLP). */
const A4988_SLP_PULLUP = 100_000;
const A4988_EN_PULLDOWN = 100_000;
const SERVO_MIN_V = 4.8; // TowerPro: 4.8 V operating voltage
const SERVO_MAX_V = 6.0; // TowerPro site: "4.8V – 6V are fine"

const MODE_NAMES = ['LOW', 'HIGH', 'INPUT', 'INPUT_PULLUP'];

interface LedRt {
  dev: Device;
  on: boolean;
  amps: number;
  acc: number; // A·s integrated in the current window
  last: number; // time of the last integration
  winStart: number;
  avgMa: number;
}

interface DriverRt {
  dev: Device;
  motor?: Device;
  stepper: StepperA4988;
  stepPin?: PinName;
  dirPin?: PinName;
  coilsOk: boolean;
  powered: boolean;
  awakeSince: number;
  enabled: boolean;
  reset: boolean;
  asleep: boolean;
  staticStep?: boolean;
  staticDir?: boolean;
}

/** A blank ATmega328P: 32 KB of 0x0000 (NOP), every pin an input — a board with nothing uploaded yet. */
export const BLANK_PROGRAM = new Uint16Array(0x4000);

export class LabSimulation {
  /** The Arduino on the bench, or null when the bench has no board (circuit only). */
  readonly board: ArduinoUno | null;
  readonly nets: Netlist;
  /** Problems that make the circuit meaningless (shorted supplies); the circuit is not solved while present. */
  readonly fatal: Check[] = [];
  readonly servos = new Map<string, Servo>();
  readonly buttons = new Map<string, Button>();
  readonly pots = new Map<string, Potentiometer>();
  readonly drivers = new Map<string, DriverRt>();
  private readonly leds = new Map<string, LedRt>();
  private readonly closed = new Map<string, boolean>();
  /** Reference net (0 V): the Uno's GND, else the first bench supply's −; −1 when nothing can be solved. */
  private readonly gnd: number;
  private readonly n5v: number;
  private readonly n3v3: number;
  private readonly io: PinName[];
  private clock = 0;
  private readonly unoNet = new Map<PinName, number>();
  private readonly subscribers = new Map<PinName, ((high: boolean, t: number) => void)[]>();
  private sol: Solution | null = null;
  private elements: Element[] = [];
  private dirty = true;
  private modeSig = '';
  private lastInput = new Map<PinName, boolean>();
  private checks = new Map<string, Check>();
  private serial = '';
  private rx: number[] = [];
  private peakRailMa = 0;
  private servoMa = new Map<string, number>();

  constructor(readonly project: Project, program: Uint16Array = BLANK_PROGRAM) {
    const hasBoard = project.devices.some((d) => d.kind === 'uno');
    this.board = hasBoard ? new ArduinoUno(program.length ? program : BLANK_PROGRAM) : null;
    this.nets = new Netlist(project);
    const N = this.nets;
    const psu = project.devices.find((d) => d.kind === 'psu');
    this.gnd = hasBoard ? N.net('uno.GND1') : psu ? N.net(`${psu.id}.-`) : N.count ? 0 : -1;
    this.n5v = hasBoard ? N.net('uno.5V') : -1;
    this.n3v3 = hasBoard ? N.net('uno.3V3') : -1;
    this.io = hasBoard ? IO_PINS : [];
    for (const p of this.io) this.unoNet.set(p, N.net(`uno.${p}`));
    this.findShorts();
    if (!hasBoard && !psu && project.devices.length)
      this.fatal.push({ level: 'warn', msg: 'Nothing powers this bench yet: add an Arduino or a bench supply from the shelf.' });

    for (const d of project.devices) {
      if (d.kind === 'servo') {
        const sigPin = this.unoPinOn(`${d.id}.SIG`);
        const s = new Servo(d.id, sigPin ?? 'D0');
        s.gate = () => this.servoPowered(d);
        if (sigPin) this.subscribe(sigPin, (high, t) => s.onPin(sigPin, high, t));
        this.servos.set(d.id, s);
      } else if (d.kind === 'button') {
        const b = new Button(d.id, 'D0');
        b.attach({ setDigitalInput: (_p, high) => this.setClosed(d.id, !high), setAnalogInput: () => {} });
        this.closed.set(d.id, false);
        this.buttons.set(d.id, b);
      } else if (d.kind === 'pot') {
        const p = new Potentiometer(d.id, 'A0');
        p.attach({ setDigitalInput: () => {}, setAnalogInput: () => (this.dirty = true) });
        this.pots.set(d.id, p);
      } else if (d.kind === 'led') {
        this.leds.set(d.id, { dev: d, on: false, amps: 0, acc: 0, last: 0, winStart: 0, avgMa: 0 });
      } else if (d.kind === 'a4988') {
        this.setupDriver(d);
      }
    }

    this.board?.onPin((pin, high, t) => {
      this.subscribers.get(pin)?.forEach((f) => f(high, t));
      this.resolve(t);
    });
    this.board?.onSerial((ch) => {
      this.serial = (this.serial + ch).slice(-8000);
    });
    this.resolve(0);
  }

  // ───────── public API ─────────

  get time(): number {
    return this.board ? this.board.time : this.clock;
  }

  step(seconds: number): void {
    let left = seconds;
    while (left > 1e-9) {
      const dt = Math.min(0.001, left);
      if (this.board) {
        if (this.rx.length && !this.board.usart.rxBusy) this.board.usart.writeByte(this.rx.shift()!);
        this.board.run(dt);
      } else this.clock += dt;
      const t = this.time;
      for (const s of this.servos.values()) s.update(t);
      for (const b of this.buttons.values()) b.update(t);
      const sig = this.modeSignature();
      if (sig !== this.modeSig) {
        this.modeSig = sig;
        this.dirty = true;
      }
      if (this.dirty) this.resolve(t);
      this.trackRail();
      left -= dt;
    }
  }

  sendSerial(text: string): void {
    for (const ch of new TextEncoder().encode(text)) this.rx.push(ch);
  }

  /** The stepper motor's shaft angle, through whichever driver turns it. */
  motorAngle(motorId: string): number {
    for (const d of this.drivers.values()) if (d.motor?.id === motorId) return d.stepper.angle;
    return 0;
  }

  ledLevel(id: string): number {
    const l = this.leds.get(id);
    return l ? Math.min(1, this.ledAvgMa(l) / 10) : 0; // relative to 10 mA, the WP7113ID test current
  }

  builtinLed(): number {
    return this.board?.isHigh('D13') ? 1 : 0;
  }

  snapshot(): LabSnapshot {
    const t = this.time;
    const v = (pin: string) => (this.sol ? this.sol.volts[this.nets.net(pin)] : 0);
    const devices: Record<string, PartState> = {};
    for (const d of this.project.devices) {
      const id = d.id;
      if (d.kind === 'servo') {
        const s = this.servos.get(id)!;
        devices[id] = { ...s.state(), 'V+': round(v(`${id}.V+`) - v(`${id}.GND`), 2) };
      } else if (d.kind === 'a4988') {
        const r = this.drivers.get(id)!;
        devices[id] = {
          ...r.stepper.state(),
          microsteps: r.stepper.opts.microsteps,
          VMOT: round(v(`${id}.VMOT`) - v(`${id}.GND`), 1),
          VDD: round(v(`${id}.VDD`) - v(`${id}.GND`), 2),
          enabled: r.powered && r.enabled && !r.reset && !r.asleep && r.coilsOk,
        };
      } else if (d.kind === 'stepper') {
        devices[id] = { angle: round(this.motorAngle(id), 1) };
      } else if (d.kind === 'button') {
        devices[id] = { pressed: this.buttons.get(id)!.pressed };
      } else if (d.kind === 'pot') {
        devices[id] = { position: round(this.pots.get(id)!.value, 2), wiper: round(v(`${id}.W`), 2) };
      } else if (d.kind === 'led') {
        const l = this.leds.get(id)!;
        devices[id] = { mA: round(this.ledAvgMa(l), 1), lit: this.ledLevel(id) > 0.02 };
      } else if (d.kind === 'resistor') {
        const drop = v(`${id}.1`) - v(`${id}.2`);
        devices[id] = { V: round(Math.abs(drop), 2), mA: round((Math.abs(drop) / Math.max(0.01, d.props.ohms ?? 220)) * 1000, 2) };
      } else if (d.kind === 'cap') {
        devices[id] = { V: round(v(`${id}.+`) - v(`${id}.-`), 1) };
      } else if (d.kind === 'psu') {
        devices[id] = { V: d.props.volts ?? 12 };
      }
    }
    const pins: LabSnapshot['pins'] = {};
    for (const p of this.io) {
      const n = this.unoNet.get(p)!;
      pins[p] = { mode: this.pinMode(p), volts: this.sol && this.sol.driven[n] ? round(this.sol.volts[n], 2) : null };
    }
    const runtime: Check[] = [];
    for (const s of this.servos.values()) s.warnings.forEach((msg) => runtime.push({ level: 'warn', msg, device: s.id }));
    for (const r of this.drivers.values()) r.stepper.warnings.forEach((msg) => runtime.push({ level: 'warn', msg, device: r.dev.id }));
    return {
      time: t,
      devices,
      pins,
      railMa: Math.round(this.peakRailMa),
      checks: [...this.fatal, ...this.checks.values(), ...runtime],
      serial: this.serial,
    };
  }

  // ───────── setup helpers ─────────

  /** The Uno I/O pin wired to this pin's net, if any. */
  unoPinOn(pin: string): PinName | undefined {
    const n = this.nets.net(pin);
    return this.io.find((p) => this.unoNet.get(p) === n);
  }

  private subscribe(pin: PinName, f: (high: boolean, t: number) => void): void {
    this.subscribers.set(pin, [...(this.subscribers.get(pin) ?? []), f]);
  }

  private findShorts(): void {
    const supplies: { name: string; net: number; v: number }[] = this.board
      ? [
          { name: 'GND', net: this.gnd, v: 0 },
          { name: '5V', net: this.n5v, v: 5 },
          { name: '3V3', net: this.n3v3, v: 3.3 },
        ]
      : [];
    for (let i = 0; i < supplies.length; i++)
      for (let j = i + 1; j < supplies.length; j++)
        if (supplies[i].net === supplies[j].net)
          this.fatal.push({ level: 'error', msg: `Short circuit: the Uno's ${supplies[i].name} and ${supplies[j].name} pins are wired together.` });
    for (const d of this.project.devices.filter((x) => x.kind === 'psu')) {
      const p = this.nets.net(`${d.id}.+`);
      const n = this.nets.net(`${d.id}.-`);
      if (p === n) this.fatal.push({ level: 'error', msg: `Short circuit: ${d.id} + and − are wired together.`, device: d.id });
      for (const s of supplies) {
        if (s.net === p && s.name !== 'GND') this.fatal.push({ level: 'error', msg: `${d.id} + is wired to the Uno ${s.name} pin: two supplies fight (back-feeding the Uno).`, device: d.id });
        if (s.net === n && s.name !== 'GND') this.fatal.push({ level: 'error', msg: `${d.id} − is wired to the Uno ${s.name} pin.`, device: d.id });
      }
      if (this.board && p === this.gnd && n !== this.gnd) this.fatal.push({ level: 'error', msg: `${d.id} + is wired to GND.`, device: d.id });
    }
  }

  private setupDriver(d: Device): void {
    const id = d.id;
    const stepPin = this.unoPinOn(`${id}.STEP`);
    const dirPin = this.unoPinOn(`${id}.DIR`);
    const stepper = new StepperA4988(id, 'STEP' as PinName, 'DIR' as PinName);
    const rt: DriverRt = { dev: d, stepper, stepPin, dirPin, coilsOk: false, powered: false, awakeSince: -Infinity, enabled: false, reset: true, asleep: false };
    stepper.gate = () =>
      rt.powered && !rt.reset && !rt.asleep && rt.enabled && rt.coilsOk && this.time - rt.awakeSince >= SPEC.a4988.wakeMs / 1000;
    if (stepPin) this.subscribe(stepPin, (high, t) => stepper.onPin(stepper.stepPin, high, t));
    if (dirPin) this.subscribe(dirPin, (high, t) => stepper.onPin(stepper.dirPin, high, t));

    // which motor is on the outputs, and how its coils are paired
    const lead = (out: string) => {
      const n = this.nets.net(`${id}.${out}`);
      for (const m of this.project.devices.filter((x) => x.kind === 'stepper'))
        for (const l of ['A+', 'A-', 'B+', 'B-']) if (this.nets.net(`${m.id}.${l}`) === n) return { motor: m, lead: l };
      return undefined;
    };
    const o = { '1A': lead('1A'), '1B': lead('1B'), '2A': lead('2A'), '2B': lead('2B') };
    const motor = o['1A']?.motor ?? o['1B']?.motor ?? o['2A']?.motor ?? o['2B']?.motor;
    rt.motor = motor;
    if (motor) {
      const all = Object.values(o);
      const sameMotor = all.every((x) => x && x.motor.id === motor.id);
      const c1 = o['1A'] && o['1B'] ? [o['1A'].lead, o['1B'].lead] : null;
      const c2 = o['2A'] && o['2B'] ? [o['2A'].lead, o['2B'].lead] : null;
      const coil = (c: string[] | null) => (c && c[0][0] === c[1][0] && c[0] !== c[1] ? c[0][0] : null);
      const k1 = coil(c1);
      const k2 = coil(c2);
      if (!sameMotor || !c1 || !c2) {
        this.addStatic(`${id}.coils`, 'warn', `${id}: all four motor leads must go to 1A, 1B, 2A, 2B — the motor will not turn.`, id);
      } else if (!k1 || !k2 || k1 === k2) {
        this.addStatic(`${id}.coils`, 'warn', `${id}: 1A/1B and 2A/2B must each be one motor coil (A+/A− and B+/B−). Mixed pairs make the motor buzz instead of turning.`, id);
      } else {
        rt.coilsOk = true;
        const s1 = o['1A']!.lead.endsWith('+') ? 1 : -1;
        const s2 = o['2A']!.lead.endsWith('+') ? 1 : -1;
        stepper.dirSign = s1 * s2 * (k1 === 'A' ? 1 : -1);
      }
    }
    // VMOT capacitor (Pololu: at least 47 µF electrolytic across VMOT and GND)
    const vmot = this.nets.net(`${id}.VMOT`);
    const gndc = this.nets.net(`${id}.GND`);
    const caps = this.project.devices.filter((x) => x.kind === 'cap');
    const good = caps.some((c) => this.nets.net(`${c.id}.+`) === vmot && this.nets.net(`${c.id}.-`) === gndc && (c.props.uf ?? 0) >= SPEC.a4988.vmotCapUf);
    const reversed = caps.find((c) => this.nets.net(`${c.id}.-`) === vmot && this.nets.net(`${c.id}.+`) === gndc);
    if (reversed) this.addStatic(`${id}.capRev`, 'warn', `${reversed.id} is reversed across VMOT: an electrolytic capacitor must have + on VMOT.`, reversed.id);
    else if (this.nets.connected(`${id}.VMOT`) && !good)
      this.addStatic(`${id}.cap`, 'warn', `${id}: Pololu recommends at least ${SPEC.a4988.vmotCapUf} µF across VMOT and GND to absorb voltage spikes.`, id);
    this.drivers.set(id, rt);
  }

  private staticChecks = new Map<string, Check>();
  private addStatic(key: string, level: Check['level'], msg: string, device?: string): void {
    this.staticChecks.set(key, { level, msg, device });
  }

  private setClosed(id: string, closed: boolean): void {
    if (this.closed.get(id) !== closed) {
      this.closed.set(id, closed);
      this.dirty = true;
    }
  }

  // ───────── circuit ─────────

  private pinState(p: PinName): PinState {
    const { port, bit } = pinLocation(p);
    return this.board!.ports[port].pinState(bit);
  }

  private pinMode(p: PinName): string {
    return MODE_NAMES[this.pinState(p)];
  }

  private modeSignature(): string {
    let s = '';
    for (const p of this.io) s += this.pinState(p);
    return s;
  }

  private buildElements(): Element[] {
    const N = this.nets;
    const E: Element[] = this.board
      ? [
          { kind: 'V', p: this.n5v, n: this.gnd, v: 5, tag: '5V' },
          { kind: 'V', p: this.n3v3, n: this.gnd, v: 3.3, tag: '3V3' },
        ]
      : [];
    for (const p of this.io) {
      const n = this.unoNet.get(p)!;
      const st = this.pinState(p);
      if (st === PinState.High) {
        E.push({ kind: 'G', a: n, b: this.gnd, g: 1 / R_SOURCE, tag: `pin:${p}` });
        E.push({ kind: 'I', from: this.gnd, to: n, i: VCC / R_SOURCE, tag: `pin:${p}` });
      } else if (st === PinState.Low) {
        E.push({ kind: 'G', a: n, b: this.gnd, g: 1 / R_SINK, tag: `pin:${p}` });
      } else if (st === PinState.InputPullUp) {
        E.push({ kind: 'G', a: n, b: this.n5v, g: 1 / R_PULLUP, tag: `pullup:${p}` });
      }
    }
    for (const d of this.project.devices) {
      const id = d.id;
      const net = (pin: string) => N.net(`${id}.${pin}`);
      if (d.kind === 'psu') E.push({ kind: 'V', p: net('+'), n: net('-'), v: d.props.volts ?? 12, tag: id });
      else if (d.kind === 'resistor') E.push({ kind: 'G', a: net('1'), b: net('2'), g: 1 / Math.max(0.01, d.props.ohms ?? 220), tag: id });
      else if (d.kind === 'pot') {
        const pos = this.pots.get(id)!.value;
        const R = SPEC.ptv09.ohms;
        E.push({ kind: 'G', a: net('1'), b: net('W'), g: 1 / Math.max(1, R * pos), tag: id });
        E.push({ kind: 'G', a: net('W'), b: net('3'), g: 1 / Math.max(1, R * (1 - pos)), tag: id });
      } else if (d.kind === 'button') {
        if (this.closed.get(id)) E.push({ kind: 'G', a: net('1'), b: net('3'), g: 1 / SPEC.b3f.contactOhms, tag: id });
      } else if (d.kind === 'led') {
        const l = this.leds.get(id)!;
        if (l.on) {
          const g = 1 / LED_RS;
          E.push({ kind: 'G', a: net('A'), b: net('K'), g, tag: id });
          E.push({ kind: 'I', from: net('K'), to: net('A'), i: g * SPEC.wp7113id.vfTyp, tag: id });
        }
      } else if (d.kind === 'a4988') {
        const g = net('GND');
        const a = SPEC.a4988;
        E.push({ kind: 'G', a: net('MS1'), b: g, g: 1 / a.ms1PulldownOhms });
        E.push({ kind: 'G', a: net('MS2'), b: g, g: 1 / a.ms2PulldownOhms });
        E.push({ kind: 'G', a: net('MS3'), b: g, g: 1 / a.ms3PulldownOhms });
        E.push({ kind: 'G', a: net('SLP'), b: net('VDD'), g: 1 / A4988_SLP_PULLUP });
        E.push({ kind: 'G', a: net('EN'), b: g, g: 1 / A4988_EN_PULLDOWN });
      }
    }
    return E;
  }

  /** Re-solve the circuit at time t and push the result into the Uno pins and the devices. */
  private resolve(t: number): void {
    this.dirty = false;
    this.integrateLeds(t);
    if (this.fatal.length || this.gnd < 0) {
      this.sol = null;
      return;
    }
    let sol: Solution | null = null;
    for (let iter = 0; iter < 8; iter++) {
      this.elements = this.buildElements();
      sol = solve(this.nets.count, this.gnd, this.elements);
      let changed = false;
      for (const l of this.leds.values()) {
        const vd = sol.volts[this.nets.net(`${l.dev.id}.A`)] - sol.volts[this.nets.net(`${l.dev.id}.K`)];
        const i = (vd - SPEC.wp7113id.vfTyp) / LED_RS;
        if (l.on && i < 0) (l.on = false), (changed = true);
        else if (!l.on && vd > SPEC.wp7113id.vfTyp + 1e-6) (l.on = true), (changed = true);
      }
      if (!changed) break;
    }
    this.sol = sol!;
    this.applyInputs(t);
    this.evaluate(t);
  }

  private applyInputs(t: number): void {
    const sol = this.sol!;
    const board = this.board;
    if (!board) return;
    for (const p of this.io) {
      const st = this.pinState(p);
      if (st !== PinState.Input && st !== PinState.InputPullUp) continue;
      const n = this.unoNet.get(p)!;
      const v = sol.volts[n];
      if (p[0] === 'A') board.setAnalogInput(p as (typeof ANALOG_PINS)[number], sol.driven[n] ? v : 0);
      if (!sol.driven[n]) continue; // floating: the pin keeps its last level (reported in checks)
      let level = this.lastInput.get(p) ?? false;
      if (v >= M.vihFrac * VCC) level = true;
      else if (v <= M.vilFrac * VCC) level = false;
      if (this.lastInput.get(p) !== level || t === 0) {
        this.lastInput.set(p, level);
        board.setDigitalInput(p, level);
      }
    }
  }

  /** Device states and checks that depend on voltages. */
  private evaluate(t: number): void {
    const sol = this.sol!;
    const N = this.nets;
    const V = (pin: string) => sol.volts[N.net(pin)];
    const checks = new Map(this.staticChecks);
    const add = (key: string, level: Check['level'], msg: string, device?: string) => checks.set(key, { level, msg, device });

    // Uno pins: floating inputs, over-current, pins tied together
    for (const p of this.io) {
      const n = this.unoNet.get(p)!;
      const st = this.pinState(p);
      const wired = N.connected(`uno.${p}`);
      if (wired && (st === PinState.Input || st === PinState.InputPullUp) && !sol.driven[n])
        add(`float:${p}`, 'warn', `${p} is an input but nothing drives it while it is open — it floats and reads at random. Use INPUT_PULLUP or a pull-down resistor.`);
      const vin = sol.volts[n];
      // analog pins are normally read with analogRead, where a mid-rail voltage is the point
      if (wired && p[0] === 'D' && st === PinState.Input && sol.driven[n] && vin > M.vilFrac * VCC && vin < M.vihFrac * VCC)
        add(`mid:${p}`, 'warn', `${p} sits at ${vin.toFixed(2)} V, between the ATmega328P's 0.3·VCC and 0.6·VCC thresholds: its reading is undefined.`);
      if (st === PinState.High || st === PinState.Low) {
        const ma = (st === PinState.High ? (VCC - vin) / R_SOURCE : vin / R_SINK) * 1000;
        if (Math.abs(ma) > M.pinAbsMaxMa)
          add(`oc:${p}`, 'error', `${p} ${st === PinState.High ? 'sources' : 'sinks'} ~${Math.abs(ma).toFixed(0)} mA — above the ATmega328P's ${M.pinAbsMaxMa} mA absolute maximum per pin. Add a resistor or check for a short.`);
      }
      const others = this.io.filter((q) => q !== p && this.unoNet.get(q) === n);
      if (others.length && p < others[0]) add(`tied:${p}`, 'warn', `${[p, ...others].join(' and ')} are wired together: if both are outputs at different levels they fight.`);
    }

    // servos
    for (const d of this.project.devices.filter((x) => x.kind === 'servo')) {
      const vplus = V(`${d.id}.V+`) - V(`${d.id}.GND`);
      if (!this.unoPinOn(`${d.id}.SIG`)) add(`${d.id}.sig`, 'warn', `${d.id}: SIG (orange) is not wired to an Arduino pin.`, d.id);
      if (this.board && N.net(`${d.id}.GND`) !== this.gnd) add(`${d.id}.gnd`, 'warn', `${d.id}: its GND is not common with the Uno's GND, so the signal has no reference — it will not respond.`, d.id);
      else if (vplus < SERVO_MIN_V - 0.05 || vplus > SERVO_MAX_V + 0.05)
        add(`${d.id}.v`, 'warn', `${d.id}: V+ is ${vplus.toFixed(2)} V; the SG90 is specified for ${SERVO_MIN_V}–${SERVO_MAX_V} V.`, d.id);
    }

    // drivers
    for (const r of this.drivers.values()) {
      const id = r.dev.id;
      const g = V(`${id}.GND`);
      const vdd = V(`${id}.VDD`) - g;
      const vmot = V(`${id}.VMOT`) - g;
      const a = SPEC.a4988;
      const logicOk = sol.driven[N.net(`${id}.VDD`)] && vdd >= a.vddMinV && vdd <= a.vddMaxV;
      const motorOk = sol.driven[N.net(`${id}.VMOT`)] && vmot >= a.vmotMinV && vmot <= a.vmotMaxV;
      if (!logicOk) add(`${id}.vdd`, 'warn', `${id}: VDD is ${vdd.toFixed(2)} V — the logic side needs ${a.vddMinV}–${a.vddMaxV} V (e.g. the Uno 5V pin).`, id);
      if (!motorOk) add(`${id}.vmot`, 'warn', `${id}: VMOT is ${vmot.toFixed(1)} V — the motor side needs ${a.vmotMinV}–${a.vmotMaxV} V from its own supply.`, id);
      if ((r.stepPin || r.dirPin) && N.net(`${id}.GND`) !== this.gnd) add(`${id}.gnd`, 'warn', `${id}: GND is not common with the Uno, so STEP/DIR have no reference.`, id);
      const level = (pin: string): boolean | null => {
        const n = N.net(`${id}.${pin}`);
        if (!sol.driven[n]) return null;
        const x = sol.volts[n] - g;
        return x >= a.logicHighFrac * vdd ? true : x <= a.logicLowFrac * vdd ? false : null;
      };
      const rst = level('RST');
      const slp = level('SLP');
      const en = level('EN');
      if (rst === null) add(`${id}.rst`, 'warn', `${id}: RST is floating (Pololu) — tie it to SLP or drive it high, or every STEP is ignored.`, id);
      else if (!rst) add(`${id}.rst`, 'warn', `${id}: RST is low — the A4988 ignores STEP while in reset.`, id);
      if (slp === false) add(`${id}.slp`, 'warn', `${id}: SLP is low — the driver is asleep.`, id);
      if (en === true) add(`${id}.en`, 'warn', `${id}: EN is high — the outputs are disabled.`, id);
      for (const pin of ['STEP', 'DIR'])
        if (!sol.driven[N.net(`${id}.${pin}`)]) add(`${id}.${pin}`, 'warn', `${id}: ${pin} is floating — Pololu: STEP and DIR are not pulled to any level internally.`, id);
      const wasAsleep = r.asleep || !r.powered;
      r.powered = !!(logicOk && motorOk);
      r.reset = rst !== true;
      r.asleep = slp !== true;
      r.enabled = en !== true;
      // powered and awake before the firmware starts counts as long awake; waking during the run needs 1 ms
      if (wasAsleep && !r.asleep && r.powered && t > 0) r.awakeSince = t;
      const ms = [level('MS1'), level('MS2'), level('MS3')].map((x) => !!x);
      r.stepper.opts.microsteps = ms[2] ? 16 : ms[0] && ms[1] ? 8 : ms[1] ? 4 : ms[0] ? 2 : 1; // Allegro Table 1
      // static STEP/DIR (tied to a rail instead of an Arduino pin)
      if (!r.dirPin) {
        const d = level('DIR');
        if (d !== null && d !== r.staticDir) (r.staticDir = d), r.stepper.onPin(r.stepper.dirPin, d, t);
      }
      if (!r.stepPin) {
        const s = level('STEP');
        if (s !== null && s !== r.staticStep) (r.staticStep = s), r.stepper.onPin(r.stepper.stepPin, s, t);
      }
    }

    // LEDs, buttons, caps, VIN
    for (const l of this.leds.values()) {
      const id = l.dev.id;
      const vd = V(`${id}.A`) - V(`${id}.K`);
      l.amps = l.on ? Math.max(0, (vd - SPEC.wp7113id.vfTyp) / LED_RS) : 0;
      if (l.amps * 1000 > SPEC.wp7113id.ifMaxMa) add(`${id}.oc`, 'error', `${id}: ~${(l.amps * 1000).toFixed(0)} mA through the LED, above its ${SPEC.wp7113id.ifMaxMa} mA maximum — add or raise the series resistor: R ≥ (supply − ${SPEC.wp7113id.vfTyp} V) / ${SPEC.wp7113id.ifMaxMa} mA.`, id);
      if (vd < -2) add(`${id}.rev`, 'warn', `${id}: reverse-biased — it will not light. The anode (A+, long leg) goes to the positive side.`, id);
    }
    for (const d of this.project.devices.filter((x) => x.kind === 'button')) {
      const n1 = N.net(`${d.id}.1`);
      const n3 = N.net(`${d.id}.3`);
      if (n1 === n3) add(`${d.id}.short`, 'warn', `${d.id}: both contact pairs are on the same net, so pressing it changes nothing.`, d.id);
      else if (N.connected(`${d.id}.1`) !== N.connected(`${d.id}.3`))
        add(`${d.id}.oneside`, 'warn', `${d.id}: only one contact pair is wired. Legs 1–2 (and 3–4) are the same contact; wire one side to 1 and the other to 3.`, d.id);
    }
    for (const d of this.project.devices.filter((x) => x.kind === 'cap')) {
      if (V(`${d.id}.+`) - V(`${d.id}.-`) < -0.5) add(`${d.id}.rev`, 'error', `${d.id}: reverse voltage across an electrolytic capacitor — swap its leads.`, d.id);
    }
    if (this.board && N.connected('uno.VIN')) {
      const vin = V('uno.VIN');
      if (sol.driven[N.net('uno.VIN')] && (vin < SPEC.uno.vinMinV || vin > SPEC.uno.vinMaxV))
        add('vin', 'warn', `VIN is ${vin.toFixed(1)} V; the UNO R3 datasheet recommends ${SPEC.uno.vinMinV}–${SPEC.uno.vinMaxV} V.`);
    }
    this.checks = checks;
  }

  private servoPowered(d: Device): boolean {
    if (!this.sol || !this.board || this.nets.net(`${d.id}.GND`) !== this.gnd) return false;
    const v = this.sol.volts[this.nets.net(`${d.id}.V+`)] - this.sol.volts[this.nets.net(`${d.id}.GND`)];
    return v >= SERVO_MIN_V - 0.05 && v <= SERVO_MAX_V + 0.05;
  }

  private integrateLeds(t: number): void {
    for (const l of this.leds.values()) {
      l.acc += l.amps * Math.max(0, t - l.last);
      l.last = t;
      const span = t - l.winStart;
      if (span >= 0.02) {
        l.avgMa = (l.acc / span) * 1000;
        l.acc = 0;
        l.winStart = t;
      }
    }
  }

  private ledAvgMa(l: LedRt): number {
    return l.winStart === 0 && l.avgMa === 0 ? l.amps * 1000 : l.avgMa;
  }

  /** 5 V rail: solved draw from the 5V and 3V3 pins and high outputs, plus device and board figures. */
  private trackRail(): void {
    if (!this.sol || !this.board) return;
    let a = 0;
    this.elements.forEach((e, i) => {
      if (e.kind === 'V' && (e.tag === '5V' || e.tag === '3V3')) a += Math.max(0, this.sol!.sourceAmps.get(i) ?? 0);
    });
    for (const p of this.io) {
      if (this.pinState(p) === PinState.High) a += Math.max(0, (VCC - this.sol.volts[this.unoNet.get(p)!]) / R_SOURCE);
    }
    let ma = a * 1000 + SPEC.uno.boardMaApprox + (this.board.isHigh('D13') ? (VCC / SPEC.uno.builtinLedSeriesOhms) * 1000 : 0);
    for (const [id, s] of this.servos) {
      const on5v = this.nets.net(`${id}.V+`) === this.n5v;
      const draw = on5v && s.moving ? SPEC.sg90.movingMaApprox : 0;
      this.servoMa.set(id, draw);
      ma += draw;
    }
    for (const r of this.drivers.values()) if (this.nets.net(`${r.dev.id}.VDD`) === this.n5v) ma += SPEC.a4988.logicMaMax;
    this.peakRailMa = Math.max(this.peakRailMa, ma);
    if (ma > SPEC.uno.usbFuseMa)
      this.checks.set('rail', { level: 'warn', msg: `5 V rail draws ~${Math.round(ma)} mA (approx.), above the ${SPEC.uno.usbFuseMa} mA USB fuse on the Uno — power servos from a separate 5 V supply with a common ground.` });
  }
}

function round(x: number, d: number): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

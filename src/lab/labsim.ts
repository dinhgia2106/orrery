// Runs a lab project: real firmware on every Arduino on the bench, the circuit solved from the user's wiring,
// and the device models driven from it. Wiring mistakes surface as checks, the way they would on a real bench.
import { ANALOG_PINS, ArduinoUno, DIGITAL_PINS, pinLocation, type PinName } from '../sim/board';
import { SPEC } from '../sim/catalog';
import { Button, Potentiometer, Servo, StepperA4988, type PartState } from '../sim/parts';
import { PinState } from 'avr8js';
import { jointValues, type Assembly } from '../mech/assembly';
import { gravityLoads, type ActuatorLoad, type Loads, type MassProps } from '../mech/physics';
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
  /** Keyed "boardId.pin". */
  pins: Record<string, { mode: string; volts: number | null }>;
  /** Peak 5 V rail current of the busiest board. */
  railMa: number;
  /** Per board. */
  rails: Record<string, number>;
  checks: Check[];
  /** Serial output per board. */
  serial: Record<string, string>;
  /** Gravity load on each actuator of the mechanism, when its masses are known. */
  actuators: ActuatorLoad[];
  /** Total mass of the mechanism and its mounted parts, g. */
  mechanismMassG: number | null;
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

/** A blank ATmega328P: 32 KB of 0x0000 (NOP), every pin an input — a board with nothing uploaded yet. */
export const BLANK_PROGRAM = new Uint16Array(0x4000);

interface BoardRt {
  id: string;
  board: ArduinoUno;
  gnd: number;
  n5v: number;
  n3v3: number;
  net: Map<PinName, number>;
  subscribers: Map<PinName, ((high: boolean, t: number) => void)[]>;
  lastInput: Map<PinName, boolean>;
  serial: string;
  rx: number[];
  peakRailMa: number;
  /** Boards whose RX (D0) is wired to this board's TX (D1). */
  listeners: BoardRt[];
}

/** An Arduino pin: which board, which pin. */
interface Pin {
  b: BoardRt;
  pin: PinName;
}

interface LedRt {
  dev: Device;
  on: boolean;
  amps: number;
  acc: number;
  last: number;
  winStart: number;
  avgMa: number;
}

interface DriverRt {
  dev: Device;
  motor?: Device;
  stepper: StepperA4988;
  step?: Pin;
  dir?: Pin;
  coilsOk: boolean;
  powered: boolean;
  awakeSince: number;
  enabled: boolean;
  reset: boolean;
  asleep: boolean;
  staticStep?: boolean;
  staticDir?: boolean;
}

export class LabSimulation {
  readonly boards: BoardRt[] = [];
  readonly nets: Netlist;
  /** Problems that make the circuit meaningless (shorted supplies); the circuit is not solved while present. */
  readonly fatal: Check[] = [];
  readonly servos = new Map<string, Servo>();
  readonly buttons = new Map<string, Button>();
  readonly pots = new Map<string, Potentiometer>();
  readonly drivers = new Map<string, DriverRt>();
  private readonly leds = new Map<string, LedRt>();
  private readonly closed = new Map<string, boolean>();
  private readonly servoPin = new Map<string, Pin>();
  /** Reference net (0 V): the first board's GND, else the first bench supply's −; −1 when nothing can be solved. */
  private readonly gnd: number;
  private clock = 0;
  private sol: Solution | null = null;
  private elements: Element[] = [];
  private dirty = true;
  private modeSig = '';
  private checks = new Map<string, Check>();
  private staticChecks = new Map<string, Check>();
  private mech: { asm: Assembly; props: Map<string, MassProps> } | null = null;
  private loads: Loads | null = null;
  private slice = 0;
  /** "board.pin" whose net reaches only high-impedance inputs (servo SIG, A4988 STEP/DIR): an edge there changes no voltage elsewhere. */
  private readonly quiet = new Set<string>();
  /** Logic edges each net has carried (for drawing signal activity on wires). */
  private readonly edges = new Map<number, number>();

  /**
   * @param programs firmware per board id; a single program goes to the first board (older callers).
   *   Boards without one run BLANK_PROGRAM.
   */
  constructor(readonly project: Project, programs: Record<string, Uint16Array> | Uint16Array = {}) {
    this.nets = new Netlist(project);
    const N = this.nets;
    const boardDevs = project.devices.filter((d) => d.kind === 'uno');
    const prog = (id: string, i: number) => {
      const p = programs instanceof Uint16Array ? (i === 0 ? programs : undefined) : programs[id];
      return p && p.length ? p : BLANK_PROGRAM;
    };
    boardDevs.forEach((d, i) => {
      const b: BoardRt = {
        id: d.id,
        board: new ArduinoUno(prog(d.id, i)),
        gnd: N.net(`${d.id}.GND1`),
        n5v: N.net(`${d.id}.5V`),
        n3v3: N.net(`${d.id}.3V3`),
        net: new Map(IO_PINS.map((p) => [p, N.net(`${d.id}.${p}`)])),
        subscribers: new Map(),
        lastInput: new Map(),
        serial: '',
        rx: [],
        peakRailMa: 0,
        listeners: [],
      };
      this.boards.push(b);
    });
    const psu = project.devices.find((d) => d.kind === 'psu');
    this.gnd = this.boards.length ? this.boards[0].gnd : psu ? N.net(`${psu.id}.-`) : N.count ? 0 : -1;
    this.findShorts();
    if (!this.boards.length && !psu && project.devices.length)
      this.fatal.push({ level: 'warn', msg: 'Nothing powers this bench yet: add an Arduino or a bench supply from the shelf.' });

    // serial links: TX (D1) of one board wired to RX (D0) of another
    for (const a of this.boards)
      for (const b of this.boards) if (a !== b && a.net.get('D1') === b.net.get('D0')) a.listeners.push(b);

    for (const d of project.devices) {
      if (d.kind === 'servo') {
        const sig = this.arduinoPinOn(`${d.id}.SIG`);
        const s = new Servo(d.id, sig?.pin ?? 'D0');
        s.gate = () => this.servoPowered(d);
        if (sig) {
          this.servoPin.set(d.id, sig);
          this.subscribe(sig, (high, t) => s.onPin(sig.pin, high, t));
        }
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

    this.findQuietPins();
    for (const b of this.boards) {
      b.board.onPin((pin, high, t) => {
        const n = b.net.get(pin);
        if (n !== undefined) this.edges.set(n, (this.edges.get(n) ?? 0) + 1);
        b.subscribers.get(pin)?.forEach((f) => f(high, t));
        if (!this.quiet.has(`${b.id}.${pin}`)) this.resolve(t);
      });
      b.board.onSerial((ch) => {
        b.serial = (b.serial + ch).slice(-8000);
        for (const l of b.listeners) l.rx.push(ch.charCodeAt(0));
      });
    }
    this.resolve(0);
  }

  // ───────── public API ─────────

  /** The first board (most benches have one), or null. */
  get board(): ArduinoUno | null {
    return this.boards[0]?.board ?? null;
  }

  get time(): number {
    return this.clock;
  }

  step(seconds: number): void {
    let left = seconds;
    while (left > 1e-9) {
      const dt = Math.min(0.001, left);
      for (const b of this.boards) {
        // a byte leaves the queue once the receiver takes it (RX enabled and idle); avr8js reports a byte when
        // transmission starts, so without this the first byte could reach a board before its Serial.begin()
        if (b.rx.length && !b.board.usart.rxBusy && b.board.usart.writeByte(b.rx[0])) b.rx.shift();
        b.board.run(dt);
      }
      this.clock += dt;
      const t = this.clock;
      for (const s of this.servos.values()) s.update(t);
      for (const b of this.buttons.values()) b.update(t);
      const sig = this.modeSignature();
      if (sig !== this.modeSig) {
        this.modeSig = sig;
        this.dirty = true;
      }
      if (this.dirty) this.resolve(t);
      if (this.mech && this.slice++ % 10 === 0) this.updateLoads(); // every 10 ms: a servo turns at most 6° in that time
      this.trackRails();
      left -= dt;
    }
  }

  /** Give the simulation the mechanism and its mass properties: actuators then carry its gravity loads. */
  setMechanics(asm: Assembly | undefined, props: Map<string, MassProps> | null): void {
    this.mech = asm && props ? { asm, props } : null;
    if (!this.mech) {
      this.loads = null;
      for (const s of this.servos.values()) s.loadKgfCm = 0;
      for (const d of this.drivers.values()) d.stepper.loadKgfCm = 0;
      return;
    }
    this.updateLoads();
  }

  private updateLoads(): void {
    const { asm, props } = this.mech!;
    const stepperMounted = new Set((asm.mounts ?? []).filter((m) => m.kind === 'stepper').map((m) => m.device));
    const values = jointValues(asm, (d) => this.servos.get(d)?.angle ?? (stepperMounted.has(d) ? this.motorAngle(d) : undefined));
    this.loads = gravityLoads(asm, props, values);
    for (const [id, s] of this.servos) s.loadKgfCm = this.loads.actuators.get(id)?.torqueKgfCm ?? 0;
    for (const d of this.drivers.values()) d.stepper.loadKgfCm = (d.motor && this.loads.actuators.get(d.motor.id)?.torqueKgfCm) || 0;
  }

  /** Type into a board's serial port (the first board when no id is given). */
  sendSerial(text: string, boardId?: string): void {
    const b = boardId ? this.boards.find((x) => x.id === boardId) : this.boards[0];
    if (b) for (const ch of new TextEncoder().encode(text)) b.rx.push(ch);
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

  /** The on-board "L" LED (D13) of a board. */
  builtinLed(boardId?: string): number {
    const b = boardId ? this.boards.find((x) => x.id === boardId) : this.boards[0];
    return b?.board.isHigh('D13') ? 1 : 0;
  }

  /**
   * The net a pin ("servo1.SIG", "uno.D9") is on, as a wire would show it: its voltage against the reference
   * ground and how many logic edges a board pin has put on it so far.
   */
  netState(ref: string): { volts: number; edges: number } {
    let n: number;
    try {
      n = this.nets.net(ref);
    } catch {
      return { volts: 0, edges: 0 };
    }
    const edges = this.edges.get(n) ?? 0;
    // quiet nets are not re-solved on every edge: their level is the driving pin's
    const p = this.arduinoPinOn(ref);
    if (p && this.quiet.has(`${p.b.id}.${p.pin}`)) {
      const st = this.pinState(p);
      if (st === PinState.High || st === PinState.Low) return { volts: st === PinState.High ? VCC : 0, edges };
    }
    return { volts: this.sol && this.gnd >= 0 ? this.sol.volts[n] - this.sol.volts[this.gnd] : 0, edges };
  }

  /**
   * Torque an actuator applies to hold its mechanism against gravity, as a signed share of its stall (servo) or
   * holding (stepper) torque: positive turns it towards larger angles.
   */
  actuatorEffort(device: string): number | undefined {
    const a = this.loads?.actuators.get(device);
    return a && a.limitKgfCm > 0 ? -a.torqueKgfCm / a.limitKgfCm : undefined;
  }

  snapshot(): LabSnapshot {
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
      } else if (d.kind === 'uno') {
        const b = this.boards.find((x) => x.id === id)!;
        devices[id] = { 'peak 5V mA': Math.round(b.peakRailMa), L: b.board.isHigh('D13') };
      }
    }
    const pins: LabSnapshot['pins'] = {};
    const rails: Record<string, number> = {};
    const serial: Record<string, string> = {};
    for (const b of this.boards) {
      for (const p of IO_PINS) {
        const n = b.net.get(p)!;
        const st = this.pinState({ b, pin: p });
        // an output on a quiet net is not re-solved on every edge; with no load its voltage is the logic level
        const quietOut = this.quiet.has(`${b.id}.${p}`) && (st === PinState.High || st === PinState.Low);
        pins[`${b.id}.${p}`] = {
          mode: MODE_NAMES[st],
          volts: quietOut ? (st === PinState.High ? VCC : 0) : this.sol && this.sol.driven[n] ? round(this.sol.volts[n] - this.sol.volts[b.gnd], 2) : null,
        };
      }
      rails[b.id] = Math.round(b.peakRailMa);
      serial[b.id] = b.serial;
    }
    const runtime: Check[] = [];
    for (const s of this.servos.values()) s.warnings.forEach((msg) => runtime.push({ level: 'warn', msg, device: s.id }));
    for (const r of this.drivers.values()) r.stepper.warnings.forEach((msg) => runtime.push({ level: 'warn', msg, device: r.dev.id }));
    return {
      time: this.clock,
      devices,
      pins,
      railMa: Math.max(0, ...Object.values(rails)),
      rails,
      checks: [...this.fatal, ...this.checks.values(), ...runtime],
      serial,
      actuators: this.loads ? [...this.loads.actuators.values()] : [],
      mechanismMassG: this.loads ? this.loads.totalMassG : null,
    };
  }

  // ───────── setup helpers ─────────

  /** The Arduino I/O pin (on any board) wired to this pin's net, if any. */
  arduinoPinOn(pin: string): Pin | undefined {
    const n = this.nets.net(pin);
    for (const b of this.boards) for (const p of IO_PINS) if (b.net.get(p) === n) return { b, pin: p };
    return undefined;
  }

  /** Pin label for messages: "D2" with one board, "uno2.D2" with several. */
  private label(p: Pin): string {
    return this.boards.length > 1 ? `${p.b.id}.${p.pin}` : p.pin;
  }

  private subscribe(p: Pin, f: (high: boolean, t: number) => void): void {
    p.b.subscribers.set(p.pin, [...(p.b.subscribers.get(p.pin) ?? []), f]);
  }

  private findShorts(): void {
    // every fixed-voltage terminal of every board, by net
    const owner = new Map<number, { name: string; board: string }>();
    const claim = (net: number, name: string, board: string) => {
      const prev = owner.get(net);
      if (prev && prev.name !== name) {
        const who = (o: { name: string; board: string }) => (this.boards.length > 1 ? `${o.board} ${o.name}` : `the Uno's ${o.name}`);
        this.fatal.push({ level: 'error', msg: `Short circuit: ${who(prev)} and ${who({ name, board })} pins are wired together.` });
      } else if (!prev) owner.set(net, { name, board });
    };
    for (const b of this.boards) {
      claim(b.gnd, 'GND', b.id);
      claim(b.n5v, '5V', b.id);
      claim(b.n3v3, '3V3', b.id);
    }
    for (const d of this.project.devices.filter((x) => x.kind === 'psu')) {
      const p = this.nets.net(`${d.id}.+`);
      const n = this.nets.net(`${d.id}.-`);
      if (p === n) this.fatal.push({ level: 'error', msg: `Short circuit: ${d.id} + and − are wired together.`, device: d.id });
      const op = owner.get(p);
      const on = owner.get(n);
      if (op && op.name !== 'GND') this.fatal.push({ level: 'error', msg: `${d.id} + is wired to ${op.board} ${op.name}: two supplies fight (back-feeding the board).`, device: d.id });
      if (op && op.name === 'GND' && n !== p) this.fatal.push({ level: 'error', msg: `${d.id} + is wired to GND.`, device: d.id });
      if (on && on.name !== 'GND') this.fatal.push({ level: 'error', msg: `${d.id} − is wired to ${on.board} ${on.name}.`, device: d.id });
    }
  }

  private setupDriver(d: Device): void {
    const id = d.id;
    const step = this.arduinoPinOn(`${id}.STEP`);
    const dir = this.arduinoPinOn(`${id}.DIR`);
    const stepper = new StepperA4988(id, 'STEP' as PinName, 'DIR' as PinName);
    const rt: DriverRt = { dev: d, stepper, step, dir, coilsOk: false, powered: false, awakeSince: -Infinity, enabled: false, reset: true, asleep: false };
    stepper.gate = () =>
      rt.powered && !rt.reset && !rt.asleep && rt.enabled && rt.coilsOk && this.clock - rt.awakeSince >= SPEC.a4988.wakeMs / 1000;
    if (step) this.subscribe(step, (high, t) => stepper.onPin(stepper.stepPin, high, t));
    if (dir) this.subscribe(dir, (high, t) => stepper.onPin(stepper.dirPin, high, t));

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
      const sameMotor = Object.values(o).every((x) => x && x.motor.id === motor.id);
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

  private findQuietPins(): void {
    const hiZ = new Set<string>();
    for (const d of this.project.devices) {
      if (d.kind === 'servo') hiZ.add(`${d.id}.SIG`);
      if (d.kind === 'a4988') for (const p of ['STEP', 'DIR']) hiZ.add(`${d.id}.${p}`);
    }
    for (const b of this.boards)
      for (const pin of IO_PINS) {
        const members = this.nets.members[b.net.get(pin)!];
        if (members.every((m) => m === `${b.id}.${pin}` || hiZ.has(m))) this.quiet.add(`${b.id}.${pin}`);
      }
  }

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

  private pinState(p: Pin): PinState {
    // with Serial.begin() the USART owns D1: the transmitter drives TX high while idle (ATmega328P USART0)
    if (p.pin === 'D1' && p.b.board.usart.txEnable) return PinState.High;
    const { port, bit } = pinLocation(p.pin);
    return p.b.board.ports[port].pinState(bit);
  }

  /** Pin directions and pull-ups only: output levels arrive as onPin edges. */
  private modeSignature(): string {
    let s = '';
    for (const b of this.boards)
      for (const pin of IO_PINS) {
        const st = this.pinState({ b, pin });
        s += st === PinState.High || st === PinState.Low ? 'o' : st;
      }
    return s;
  }

  private buildElements(): Element[] {
    const N = this.nets;
    const E: Element[] = [];
    const seen = new Set<string>();
    for (const b of this.boards) {
      // two boards whose rails are wired together share one source, not two ideal sources in parallel
      for (const [p, v, tag] of [[b.n5v, 5, '5V'], [b.n3v3, 3.3, '3V3']] as const) {
        const key = `${p}:${b.gnd}:${v}`;
        if (seen.has(key)) continue;
        seen.add(key);
        E.push({ kind: 'V', p, n: b.gnd, v, tag: `${b.id}:${tag}` });
      }
      for (const pin of IO_PINS) {
        const n = b.net.get(pin)!;
        const st = this.pinState({ b, pin });
        if (st === PinState.High) {
          E.push({ kind: 'G', a: n, b: b.gnd, g: 1 / R_SOURCE });
          E.push({ kind: 'I', from: b.gnd, to: n, i: VCC / R_SOURCE });
        } else if (st === PinState.Low) {
          E.push({ kind: 'G', a: n, b: b.gnd, g: 1 / R_SINK });
        } else if (st === PinState.InputPullUp) {
          E.push({ kind: 'G', a: n, b: b.n5v, g: 1 / R_PULLUP });
        }
      }
    }
    for (const d of this.project.devices) {
      const id = d.id;
      const net = (pin: string) => N.net(`${id}.${pin}`);
      if (d.kind === 'psu') E.push({ kind: 'V', p: net('+'), n: net('-'), v: d.props.volts ?? 12, tag: id });
      else if (d.kind === 'resistor') E.push({ kind: 'G', a: net('1'), b: net('2'), g: 1 / Math.max(0.01, d.props.ohms ?? 220) });
      else if (d.kind === 'pot') {
        const pos = this.pots.get(id)!.value;
        const R = SPEC.ptv09.ohms;
        E.push({ kind: 'G', a: net('1'), b: net('W'), g: 1 / Math.max(1, R * pos) });
        E.push({ kind: 'G', a: net('W'), b: net('3'), g: 1 / Math.max(1, R * (1 - pos)) });
      } else if (d.kind === 'button') {
        if (this.closed.get(id)) E.push({ kind: 'G', a: net('1'), b: net('3'), g: 1 / SPEC.b3f.contactOhms });
      } else if (d.kind === 'led') {
        if (this.leds.get(id)!.on) {
          const g = 1 / LED_RS;
          E.push({ kind: 'G', a: net('A'), b: net('K'), g });
          E.push({ kind: 'I', from: net('K'), to: net('A'), i: g * SPEC.wp7113id.vfTyp });
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

  /** Re-solve the circuit at time t and push the result into the board pins and the devices. */
  private resolve(t: number): void {
    this.dirty = false;
    this.integrateLeds(t);
    if (this.fatal.some((c) => c.level === 'error') || this.gnd < 0 || (!this.boards.length && this.fatal.length)) {
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
    for (const b of this.boards) {
      for (const pin of IO_PINS) {
        const st = this.pinState({ b, pin });
        if (st !== PinState.Input && st !== PinState.InputPullUp) continue;
        const n = b.net.get(pin)!;
        const v = sol.volts[n] - sol.volts[b.gnd];
        if (pin[0] === 'A') b.board.setAnalogInput(pin as (typeof ANALOG_PINS)[number], sol.driven[n] ? v : 0);
        if (!sol.driven[n]) continue; // floating: the pin keeps its last level (reported in checks)
        let level = b.lastInput.get(pin) ?? false;
        if (v >= M.vihFrac * VCC) level = true;
        else if (v <= M.vilFrac * VCC) level = false;
        if (b.lastInput.get(pin) !== level || t === 0) {
          b.lastInput.set(pin, level);
          b.board.setDigitalInput(pin, level);
        }
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

    // board pins: floating inputs, over-current, pins tied together
    for (const b of this.boards) {
      for (const pin of IO_PINS) {
        const p = { b, pin };
        const n = b.net.get(pin)!;
        const st = this.pinState(p);
        const wired = N.connected(`${b.id}.${pin}`);
        const L = this.label(p);
        if (wired && (st === PinState.Input || st === PinState.InputPullUp) && !sol.driven[n])
          add(`float:${L}`, 'warn', `${L} is an input but nothing drives it while it is open — it floats and reads at random. Use INPUT_PULLUP or a pull-down resistor.`, b.id);
        const vin = sol.volts[n] - sol.volts[b.gnd];
        // analog pins are normally read with analogRead, where a mid-rail voltage is the point
        if (wired && pin[0] === 'D' && st === PinState.Input && sol.driven[n] && vin > M.vilFrac * VCC && vin < M.vihFrac * VCC)
          add(`mid:${L}`, 'warn', `${L} sits at ${vin.toFixed(2)} V, between the ATmega328P's 0.3·VCC and 0.6·VCC thresholds: its reading is undefined.`, b.id);
        if (st === PinState.High || st === PinState.Low) {
          const ma = (st === PinState.High ? (VCC - vin) / R_SOURCE : vin / R_SINK) * 1000;
          if (Math.abs(ma) > M.pinAbsMaxMa)
            add(`oc:${L}`, 'error', `${L} ${st === PinState.High ? 'sources' : 'sinks'} ~${Math.abs(ma).toFixed(0)} mA — above the ATmega328P's ${M.pinAbsMaxMa} mA absolute maximum per pin. Add a resistor or check for a short.`, b.id);
        }
        const others: Pin[] = [];
        for (const c of this.boards) for (const q of IO_PINS) if ((c !== b || q !== pin) && c.net.get(q) === n) others.push({ b: c, pin: q });
        const serialLink = others.length === 1 && others[0].b !== b && ((pin === 'D1' && others[0].pin === 'D0') || (pin === 'D0' && others[0].pin === 'D1'));
        const key = [L, ...others.map((o) => this.label(o))].sort().join('+');
        if (others.length && !serialLink && !checks.has(`tied:${key}`))
          add(`tied:${key}`, 'warn', `${[L, ...others.map((o) => this.label(o))].join(' and ')} are wired together: if both are outputs at different levels they fight.`, b.id);
        if (serialLink && N.net(`${b.id}.GND1`) !== N.net(`${others[0].b.id}.GND1`))
          add(`serialgnd:${key}`, 'warn', `${b.id} and ${others[0].b.id} talk over serial but share no ground — the levels have no common reference.`, b.id);
      }
      if (N.connected(`${b.id}.VIN`)) {
        const vin = V(`${b.id}.VIN`) - sol.volts[b.gnd];
        if (sol.driven[N.net(`${b.id}.VIN`)] && (vin < SPEC.uno.vinMinV || vin > SPEC.uno.vinMaxV))
          add(`vin:${b.id}`, 'warn', `${b.id} VIN is ${vin.toFixed(1)} V; the UNO R3 datasheet recommends ${SPEC.uno.vinMinV}–${SPEC.uno.vinMaxV} V.`, b.id);
      }
    }

    // servos
    for (const d of this.project.devices.filter((x) => x.kind === 'servo')) {
      const vplus = V(`${d.id}.V+`) - V(`${d.id}.GND`);
      const sig = this.servoPin.get(d.id);
      if (!sig) add(`${d.id}.sig`, 'warn', `${d.id}: SIG (orange) is not wired to an Arduino pin.`, d.id);
      if (sig && N.net(`${d.id}.GND`) !== sig.b.gnd) add(`${d.id}.gnd`, 'warn', `${d.id}: its GND is not common with ${sig.b.id}'s GND, so the signal has no reference — it will not respond.`, d.id);
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
      if (!logicOk) add(`${id}.vdd`, 'warn', `${id}: VDD is ${vdd.toFixed(2)} V — the logic side needs ${a.vddMinV}–${a.vddMaxV} V (e.g. a board's 5V pin).`, id);
      if (!motorOk) add(`${id}.vmot`, 'warn', `${id}: VMOT is ${vmot.toFixed(1)} V — the motor side needs ${a.vmotMinV}–${a.vmotMaxV} V from its own supply.`, id);
      const ctl = r.step ?? r.dir;
      if (ctl && N.net(`${id}.GND`) !== ctl.b.gnd) add(`${id}.gnd`, 'warn', `${id}: GND is not common with ${ctl.b.id}, so STEP/DIR have no reference.`, id);
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
      if (!r.dir) {
        const d = level('DIR');
        if (d !== null && d !== r.staticDir) (r.staticDir = d), r.stepper.onPin(r.stepper.dirPin, d, t);
      }
      if (!r.step) {
        const s = level('STEP');
        if (s !== null && s !== r.staticStep) (r.staticStep = s), r.stepper.onPin(r.stepper.stepPin, s, t);
      }
    }

    // LEDs, buttons, caps
    for (const l of this.leds.values()) {
      const id = l.dev.id;
      const vd = V(`${id}.A`) - V(`${id}.K`);
      l.amps = l.on ? Math.max(0, (vd - SPEC.wp7113id.vfTyp) / LED_RS) : 0;
      if (l.amps * 1000 > SPEC.wp7113id.ifMaxMa)
        add(`${id}.oc`, 'error', `${id}: ~${(l.amps * 1000).toFixed(0)} mA through the LED, above its ${SPEC.wp7113id.ifMaxMa} mA maximum — add or raise the series resistor: R ≥ (supply − ${SPEC.wp7113id.vfTyp} V) / ${SPEC.wp7113id.ifMaxMa} mA.`, id);
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
    this.checks = checks;
  }

  private servoPowered(d: Device): boolean {
    const sig = this.servoPin.get(d.id);
    if (!this.sol || !sig || this.nets.net(`${d.id}.GND`) !== sig.b.gnd) return false;
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

  /** Each board's 5 V rail: solved draw from its 5V/3V3 pins and high outputs, plus device and board figures. */
  private trackRails(): void {
    if (!this.sol) return;
    for (const b of this.boards) {
      let a = 0;
      this.elements.forEach((e, i) => {
        if (e.kind === 'V' && (e.tag === `${b.id}:5V` || e.tag === `${b.id}:3V3`)) a += Math.max(0, this.sol!.sourceAmps.get(i) ?? 0);
      });
      for (const pin of IO_PINS)
        if (!this.quiet.has(`${b.id}.${pin}`) && this.pinState({ b, pin }) === PinState.High)
          a += Math.max(0, (VCC - (this.sol.volts[b.net.get(pin)!] - this.sol.volts[b.gnd])) / R_SOURCE); // quiet nets carry no current
      let ma = a * 1000 + SPEC.uno.boardMaApprox + (b.board.isHigh('D13') ? (VCC / SPEC.uno.builtinLedSeriesOhms) * 1000 : 0);
      for (const [id, s] of this.servos) if (this.nets.net(`${id}.V+`) === b.n5v && s.moving) ma += SPEC.sg90.movingMaApprox;
      for (const r of this.drivers.values()) if (this.nets.net(`${r.dev.id}.VDD`) === b.n5v) ma += SPEC.a4988.logicMaMax;
      b.peakRailMa = Math.max(b.peakRailMa, ma);
      if (ma > SPEC.uno.usbFuseMa)
        this.checks.set(`rail:${b.id}`, {
          level: 'warn',
          device: b.id,
          msg: `${this.boards.length > 1 ? `${b.id}: ` : ''}5 V rail draws ~${Math.round(ma)} mA (approx.), above the ${SPEC.uno.usbFuseMa} mA USB fuse on the Uno — power servos from a separate 5 V supply with a common ground.`,
        });
    }
  }
}

function round(x: number, d: number): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

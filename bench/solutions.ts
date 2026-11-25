// Reference solutions: one correct bench per task, so the tests can show every grader passes a right answer
// (and fails wrong ones). Sketches are bench/solutions/*.ino; their .hex files are built by
// `npm run build:bench-solutions` and committed so the tests need no compiler.
import type { Assembly } from '../src/mech/assembly';
import type { Device, Project, Wire } from '../src/lab/project';

const files = import.meta.glob('./solutions/*.{ino,hex}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const file = (name: string) => {
  const f = files[`./solutions/${name}`];
  if (f === undefined) throw new Error(`bench/solutions/${name} is missing — run npm run build:bench-solutions`);
  return f;
};

let n = 0;
const w = (a: string, b: string): Wire => ({ id: `w${++n}`, a, b, color: '#3d7bff' });
const dev = (id: string, kind: Device['kind'], props: Device['props'] = {}): Device => ({ id, kind, x: 0, y: 0, props });
const UNO = dev('uno', 'uno');

const STEPPER_DEVICES = [UNO, dev('a49881', 'a4988'), dev('stepper1', 'stepper'), dev('psu1', 'psu', { volts: 12 }), dev('cap1', 'cap', { uf: 100 })];
/** The Pololu minimal wiring: STEP D3, DIR D4, RST–SLP jumper, 12 V on VMOT with 100 µF. */
const stepperWires = (): Wire[] => [
  w('a49881.STEP', 'uno.D3'),
  w('a49881.DIR', 'uno.D4'),
  w('a49881.RST', 'a49881.SLP'),
  w('a49881.VDD', 'uno.5V'),
  w('a49881.GND', 'uno.GND3'),
  w('a49881.VMOT', 'psu1.+'),
  w('a49881.GND_M', 'psu1.-'),
  w('cap1.+', 'psu1.+'),
  w('cap1.-', 'psu1.-'),
  w('a49881.1A', 'stepper1.A+'),
  w('a49881.1B', 'stepper1.A-'),
  w('a49881.2A', 'stepper1.B+'),
  w('a49881.2B', 'stepper1.B-'),
];
/** An LED with a series resistor from a board pin to GND. */
const ledOn = (pin: string, led: string, r: string, board = 'uno'): Wire[] => [w(`${board}.${pin}`, `${r}.1`), w(`${r}.2`, `${led}.A`), w(`${led}.K`, `${board}.GND1`)];
/** A pot from GND (pin 1) to 5 V (pin 3) with its wiper on an analog pin. */
const potOn = (pot: string, pin: string, board = 'uno'): Wire[] => [w(`${pot}.1`, `${board}.GND2`), w(`${pot}.W`, `${board}.${pin}`), w(`${pot}.3`, `${board}.5V`)];
/** A servo on a pin, powered from a bench supply whose − is joined to the board's GND. */
const servoOnPsu = (servo: string, pin: string, board = 'uno'): Wire[] => [w(`${servo}.SIG`, `${board}.${pin}`), w(`${servo}.V+`, 'psu1.+'), w(`${servo}.GND`, 'psu1.-')];
const PSU5 = dev('psu1', 'psu', { volts: 5 });

const button = (pin: string, board = 'uno') => [w('button1.1', `${board}.${pin}`), w('button1.3', `${board}.GND2`)];
const servo = (pin: string) => [w('servo1.SIG', `uno.${pin}`), w('servo1.V+', 'uno.5V'), w('servo1.GND', 'uno.GND1')];

/** A base, and a bar on a revolute joint about Z at 100 mm, driven by servo1 through `drive`. */
function arm(name: string, drive: { from: [number, number]; to: [number, number] }, payload?: { massG: number; x: number }): Assembly {
  const a: Assembly = {
    format: 'orrery.assembly',
    version: 1,
    name,
    units: 'mm',
    links: [
      { id: 'base', shape: { box: [40, 10, 40] }, position: [0, 5, 0], material: 'PLA', make: 'print' },
      { id: 'bar', shape: { box: [100, 10, 10] }, position: [50, 0, 0], material: 'PLA', make: 'print' },
    ],
    joints: [{ id: 'hinge', type: 'revolute', parent: 'base', child: 'bar', position: [0, 100, 0], axis: [0, 0, 1], drive: { device: 'servo1', ...drive } }],
    mounts: [{ device: 'servo1', kind: 'servo', link: 'base', position: [0, 10, 0] }],
  };
  if (payload) {
    a.links.push({ id: 'weight', shape: { box: [20, 20, 20] }, material: 'steel', make: 'buy', massG: payload.massG });
    a.joints.push({ id: 'weight-fix', type: 'fixed', parent: 'bar', child: 'weight', position: [payload.x, 0, 0] });
    a.hardware = [{ item: 'Spur gear pair, 4:1 (servo pinion to arm gear)', qty: 1 }];
  }
  return a;
}

export interface Solution {
  project: Project;
  firmware: Record<string, string>;
}

function project(name: string, devices: Device[], wires: Wire[], code: string, extra: Partial<Project> = {}): Project {
  return { version: 1, name, devices, wires, code, ...extra };
}

export function solutions(): Record<string, Solution> {
  return {
    'blink-2hz': { project: project('Blink 2 Hz', [UNO], [], file('blink-2hz.ino')), firmware: { uno: file('blink-2hz.hex') } },
    'button-toggle-led': {
      project: project(
        'Button toggles LED',
        [UNO, dev('button1', 'button'), dev('r1', 'resistor', { ohms: 220 }), dev('led1', 'led')],
        [...button('D2'), w('uno.D8', 'r1.1'), w('r1.2', 'led1.A'), w('led1.K', 'uno.GND1')],
        file('button-toggle-led.ino'),
      ),
      firmware: { uno: file('button-toggle-led.hex') },
    },
    'pot-servo': {
      project: project(
        'Pot steers servo',
        [UNO, dev('pot1', 'pot'), dev('servo1', 'servo')],
        [w('pot1.1', 'uno.GND2'), w('pot1.W', 'uno.A0'), w('pot1.3', 'uno.5V'), ...servo('D9')],
        file('pot-servo.ino'),
      ),
      firmware: { uno: file('pot-servo.hex') },
    },
    'serial-pong': { project: project('Serial pong', [UNO], [], file('serial-pong.ino')), firmware: { uno: file('serial-pong.hex') } },
    'stepper-one-rev': {
      project: project('One revolution', STEPPER_DEVICES, stepperWires(), file('stepper-one-rev.ino')),
      firmware: { uno: file('stepper-one-rev.hex') },
    },
    'two-board-relay': {
      project: project(
        'Two-board relay',
        [UNO, dev('uno2', 'uno'), dev('button1', 'button')],
        [...button('D2'), w('uno.D1', 'uno2.D0'), w('uno.GND1', 'uno2.GND1')],
        file('two-board-relay.ino'),
        { sketches: { uno2: file('two-board-relay.uno2.ino') } },
      ),
      firmware: { uno: file('two-board-relay.hex'), uno2: file('two-board-relay.uno2.hex') },
    },
    'arm-lift': {
      project: project(
        'Arm lift',
        [UNO, dev('servo1', 'servo'), dev('button1', 'button')],
        [...servo('D9'), ...button('D2')],
        file('arm-lift.ino'),
        { assembly: arm('arm-lift', { from: [0, 180], to: [-90, 90] }) },
      ),
      firmware: { uno: file('arm-lift.hex') },
    },
    'heavy-lift': {
      project: project(
        'Heavy lift',
        [UNO, dev('servo1', 'servo'), dev('button1', 'button')],
        [...servo('D9'), ...button('D2')],
        file('heavy-lift.ino'),
        { assembly: arm('heavy-lift', { from: [0, 180], to: [0, 45] }, { massG: 250, x: 90 }) },
      ),
      firmware: { uno: file('heavy-lift.hex') },
    },
    'sos-morse': { project: project('SOS', [UNO], [], file('sos-morse.ino')), firmware: { uno: file('sos-morse.hex') } },
    'pwm-fade': {
      project: project('Fade', [UNO, dev('r1', 'resistor', { ohms: 220 }), dev('led1', 'led')], ledOn('D9', 'led1', 'r1'), file('pwm-fade.ino')),
      firmware: { uno: file('pwm-fade.hex') },
    },
    'traffic-light': {
      project: project(
        'Traffic light',
        [UNO, dev('red', 'led'), dev('yellow', 'led', { color: '#ffcc00' }), dev('green', 'led', { color: '#33c46b' }), dev('r1', 'resistor', { ohms: 220 }), dev('r2', 'resistor', { ohms: 220 }), dev('r3', 'resistor', { ohms: 220 })],
        [...ledOn('D2', 'red', 'r1'), ...ledOn('D3', 'yellow', 'r2'), ...ledOn('D4', 'green', 'r3')],
        file('traffic-light.ino'),
      ),
      firmware: { uno: file('traffic-light.hex') },
    },
    'button-counter-serial': {
      project: project('Press counter', [UNO, dev('button1', 'button')], button('D2'), file('button-counter-serial.ino')),
      firmware: { uno: file('button-counter-serial.hex') },
    },
    'long-press': {
      project: project('Long press', [UNO, dev('button1', 'button'), dev('r1', 'resistor', { ohms: 220 }), dev('led1', 'led')], [...button('D2'), ...ledOn('D8', 'led1', 'r1')], file('long-press.ino')),
      firmware: { uno: file('long-press.hex') },
    },
    'pot-threshold': {
      project: project('Pot threshold', [UNO, dev('pot1', 'pot'), dev('r1', 'resistor', { ohms: 220 }), dev('led1', 'led')], [...potOn('pot1', 'A0'), ...ledOn('D8', 'led1', 'r1')], file('pot-threshold.ino')),
      firmware: { uno: file('pot-threshold.hex') },
    },
    'serial-led-command': { project: project('Serial LED', [UNO], [], file('serial-led-command.ino')), firmware: { uno: file('serial-led-command.hex') } },
    'serial-servo-command': {
      project: project('Serial servo', [UNO, dev('servo1', 'servo')], servo('D9'), file('serial-servo-command.ino')),
      firmware: { uno: file('serial-servo-command.hex') },
    },
    'serial-adc-read': {
      project: project('Read A0', [UNO, dev('pot1', 'pot')], potOn('pot1', 'A0'), file('serial-adc-read.ino')),
      firmware: { uno: file('serial-adc-read.hex') },
    },
    'led-from-psu': {
      // (9 V − 1.9 V VF typ) / (680 Ω + the model's 10 Ω LED resistance) = 10.3 mA
      project: project('LED on 9 V', [dev('psu1', 'psu', { volts: 9 }), dev('r1', 'resistor', { ohms: 680 }), dev('led1', 'led')], [w('psu1.+', 'r1.1'), w('r1.2', 'led1.A'), w('led1.K', 'psu1.-')], ''),
      firmware: {},
    },
    'divider-adc': {
      project: project(
        'Divider on A0',
        [UNO, dev('r1', 'resistor', { ohms: 3000 }), dev('r2', 'resistor', { ohms: 2000 })],
        [w('uno.5V', 'r1.1'), w('r1.2', 'uno.A0'), w('r2.1', 'uno.A0'), w('r2.2', 'uno.GND1')],
        file('divider-adc.ino'),
      ),
      firmware: { uno: file('divider-adc.hex') },
    },
    'two-servos-mirror': {
      project: project(
        'Mirrored servos',
        [UNO, PSU5, dev('pot1', 'pot'), dev('servo1', 'servo'), dev('servo2', 'servo')],
        [...potOn('pot1', 'A0'), ...servoOnPsu('servo1', 'D9'), ...servoOnPsu('servo2', 'D10'), w('psu1.-', 'uno.GND1')],
        file('two-servos-mirror.ino'),
      ),
      firmware: { uno: file('two-servos-mirror.hex') },
    },
    'servo-slow-sweep': {
      project: project('Slow sweep', [UNO, dev('servo1', 'servo')], servo('D9'), file('servo-slow-sweep.ino')),
      firmware: { uno: file('servo-slow-sweep.hex') },
    },
    'six-servo-supply': {
      project: project(
        'Six servos',
        [UNO, PSU5, ...[1, 2, 3, 4, 5, 6].map((k) => dev(`servo${k}`, 'servo'))],
        [...['D3', 'D5', 'D6', 'D9', 'D10', 'D11'].flatMap((pin, i) => servoOnPsu(`servo${i + 1}`, pin)), w('psu1.-', 'uno.GND1')],
        file('six-servo-supply.ino'),
      ),
      firmware: { uno: file('six-servo-supply.hex') },
    },
    'stepper-pot-position': {
      project: project('Stepper follows pot', [...STEPPER_DEVICES, dev('pot1', 'pot')], [...stepperWires(), ...potOn('pot1', 'A0')], file('stepper-pot-position.ino')),
      firmware: { uno: file('stepper-pot-position.hex') },
    },
    'stepper-button-jog': {
      project: project('Quarter turns', [...STEPPER_DEVICES, dev('button1', 'button')], [...stepperWires(), ...button('D2')], file('stepper-button-jog.ino')),
      firmware: { uno: file('stepper-button-jog.hex') },
    },
    'stepper-microstep': {
      project: project(
        '1/16 microsteps',
        STEPPER_DEVICES,
        [...stepperWires(), w('a49881.MS1', 'uno.5V'), w('a49881.MS2', 'uno.5V'), w('a49881.MS3', 'uno.5V')],
        file('stepper-microstep.ino'),
      ),
      firmware: { uno: file('stepper-microstep.hex') },
    },
    'stepper-speed': {
      project: project('60 rpm', STEPPER_DEVICES, stepperWires(), file('stepper-speed.ino')),
      firmware: { uno: file('stepper-speed.hex') },
    },
    'two-board-servo': {
      project: project(
        'Pot on one board, servo on the other',
        [UNO, dev('uno2', 'uno'), dev('pot1', 'pot'), dev('servo1', 'servo')],
        [...potOn('pot1', 'A0'), w('uno.D1', 'uno2.D0'), w('uno.GND1', 'uno2.GND1'), w('servo1.SIG', 'uno2.D9'), w('servo1.V+', 'uno2.5V'), w('servo1.GND', 'uno2.GND2')],
        file('two-board-servo.ino'),
        { sketches: { uno2: file('two-board-servo.uno2.ino') } },
      ),
      firmware: { uno: file('two-board-servo.hex'), uno2: file('two-board-servo.uno2.hex') },
    },
    'gripper-close': {
      project: project('Gripper', [UNO, dev('servo1', 'servo'), dev('button1', 'button')], [...servo('D9'), ...button('D2')], file('heavy-lift.ino'), { assembly: gripper() }),
      firmware: { uno: file('heavy-lift.hex') },
    },
    'pan-tilt': {
      project: project(
        'Pan-tilt',
        [UNO, PSU5, dev('panpot', 'pot'), dev('tiltpot', 'pot'), dev('servo1', 'servo'), dev('servo2', 'servo')],
        [...potOn('panpot', 'A0'), ...potOn('tiltpot', 'A1'), ...servoOnPsu('servo1', 'D9'), ...servoOnPsu('servo2', 'D10'), w('psu1.-', 'uno.GND1')],
        file('pan-tilt.ino'),
        { assembly: panTilt() },
      ),
      firmware: { uno: file('pan-tilt.hex') },
    },
    'arm-two-joint-reach': {
      project: project(
        'Two-joint reach',
        [UNO, PSU5, dev('servo1', 'servo'), dev('servo2', 'servo'), dev('button1', 'button')],
        [...servoOnPsu('servo1', 'D9'), ...servoOnPsu('servo2', 'D10'), w('psu1.-', 'uno.GND1'), ...button('D2')],
        file('arm-two-joint-reach.ino'),
        { assembly: twoJointArm() },
      ),
      firmware: { uno: file('arm-two-joint-reach.hex') },
    },
  };
}

/**
 * Two 8 × 40 × 8 mm fingers hinged 30 mm apart on a palm; servo1 turns finger1 from 10° outward (servo 0°) to
 * 15° inward (servo 180°) and finger2 follows mirrored. Pads at the tips: 43.9 mm apart open, 9.3 mm closed.
 */
function gripper(): Assembly {
  return {
    format: 'orrery.assembly',
    version: 1,
    name: 'gripper',
    units: 'mm',
    links: [
      { id: 'palm', shape: { box: [60, 10, 20] }, position: [0, 5, 0], material: 'PLA', make: 'print' },
      { id: 'finger1', shape: { box: [8, 40, 8] }, position: [0, 20, 0], material: 'PLA', make: 'print' },
      { id: 'finger2', shape: { box: [8, 40, 8] }, position: [0, 20, 0], material: 'PLA', make: 'print' },
      { id: 'pad1', shape: { sphere: 2 }, material: 'TPU', make: 'print' },
      { id: 'pad2', shape: { sphere: 2 }, material: 'TPU', make: 'print' },
    ],
    joints: [
      { id: 'j1', type: 'revolute', parent: 'palm', child: 'finger1', position: [-15, 10, 0], axis: [0, 0, 1], drive: { device: 'servo1', from: [0, 180], to: [10, -15] } },
      { id: 'j2', type: 'revolute', parent: 'palm', child: 'finger2', position: [15, 10, 0], axis: [0, 0, 1], drive: { follow: 'j1', ratio: -1 } },
      { id: 'pad1-fix', type: 'fixed', parent: 'finger1', child: 'pad1', position: [0, 40, 0] },
      { id: 'pad2-fix', type: 'fixed', parent: 'finger2', child: 'pad2', position: [0, 40, 0] },
    ],
    mounts: [{ device: 'servo1', kind: 'servo', link: 'palm', position: [0, -20, 0] }],
    hardware: [{ item: 'Spur gear pair 1:1 coupling the two fingers', qty: 1 }],
  };
}

/** Pan about Y on a base, tilt about Z on the pan stage; the camera's +X is its view direction. */
function panTilt(): Assembly {
  return {
    format: 'orrery.assembly',
    version: 1,
    name: 'pan-tilt',
    units: 'mm',
    links: [
      { id: 'base', shape: { box: [60, 10, 60] }, position: [0, 5, 0], material: 'PLA', make: 'print' },
      { id: 'stage', shape: { box: [30, 10, 30] }, position: [0, 5, 0], material: 'PLA', make: 'print' },
      { id: 'camera', shape: { box: [30, 20, 20] }, position: [15, 0, 0], material: 'PLA', make: 'print' },
    ],
    joints: [
      { id: 'pan', type: 'revolute', parent: 'base', child: 'stage', position: [0, 15, 0], axis: [0, 1, 0], drive: { device: 'servo1', from: [0, 180], to: [-90, 90] } },
      { id: 'tilt', type: 'revolute', parent: 'stage', child: 'camera', position: [0, 30, 0], axis: [0, 0, 1], drive: { device: 'servo2', from: [0, 180], to: [0, 60] } },
    ],
    mounts: [
      { device: 'servo1', kind: 'servo', link: 'base', position: [0, -20, 0] },
      { device: 'servo2', kind: 'servo', link: 'stage', position: [0, -20, 0] },
    ],
  };
}

/** Shoulder at 30 mm above the base, 100 mm upper arm, 80 mm forearm, a tip marker at the end; both straight up at servo 90°. */
function twoJointArm(): Assembly {
  return {
    format: 'orrery.assembly',
    version: 1,
    name: 'two-joint arm',
    units: 'mm',
    links: [
      { id: 'base', shape: { box: [60, 10, 60] }, position: [0, 5, 0], material: 'PLA', make: 'print' },
      { id: 'upper', shape: { box: [10, 100, 10] }, position: [0, 50, 0], material: 'PLA', make: 'print' },
      { id: 'fore', shape: { box: [10, 80, 10] }, position: [0, 40, 0], material: 'PLA', make: 'print' },
      { id: 'tip', shape: { sphere: 3 }, material: 'PLA', make: 'print' },
    ],
    joints: [
      { id: 'shoulder', type: 'revolute', parent: 'base', child: 'upper', position: [0, 30, 0], axis: [0, 0, 1], drive: { device: 'servo1', from: [0, 180], to: [90, -90] } },
      { id: 'elbow', type: 'revolute', parent: 'upper', child: 'fore', position: [0, 100, 0], axis: [0, 0, 1], drive: { device: 'servo2', from: [0, 180], to: [90, -90] } },
      { id: 'tip-fix', type: 'fixed', parent: 'fore', child: 'tip', position: [0, 80, 0] },
    ],
    mounts: [
      { device: 'servo1', kind: 'servo', link: 'base', position: [0, 10, 25] },
      { device: 'servo2', kind: 'servo', link: 'upper', position: [0, 100, 12] },
    ],
  };
}

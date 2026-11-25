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
      project: project(
        'One revolution',
        [UNO, dev('a49881', 'a4988'), dev('stepper1', 'stepper'), dev('psu1', 'psu', { volts: 12 }), dev('cap1', 'cap', { uf: 100 })],
        [
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
        ],
        file('stepper-one-rev.ino'),
      ),
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
  };
}

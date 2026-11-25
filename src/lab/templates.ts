// The templates on the shelf: example benches with their sketches, mechanisms and prebuilt firmware names.
// Kept apart from project.ts because the sketches come in through Vite's ?raw imports.
import blinkIno from '../../examples/blink/blink.ino?raw';
import robotArmIno from '../../examples/robot-arm/robot-arm.ino?raw';
import servoSweepIno from '../../examples/servo-sweep/servo-sweep.ino?raw';
import stepperIno from '../../examples/stepper-a4988/stepper-a4988.ino?raw';
import robotHandIno from '../../examples/robot-hand/robot-hand.ino?raw';
import serialEchoIno from '../../examples/serial-echo/serial-echo.ino?raw';
import serialPingIno from '../../examples/serial-ping/serial-ping.ino?raw';
import armAssembly from '../../examples/robot-arm/robot-arm.assembly.json';
import handAssembly from '../../examples/robot-hand/robot-hand.assembly.json';
import dexterousAssembly from '../../examples/dexterous-hand/dexterous-hand.assembly.json';
import dexterousIno from '../../examples/dexterous-hand/dexterous-hand.ino?raw';
import dexterousWristIno from '../../examples/dexterous-hand-wrist/dexterous-hand-wrist.ino?raw';
import type { Assembly } from '../mech/assembly';
import type { Device, Project, Wire } from './project';

const UNO: Device = { id: 'uno', kind: 'uno', x: 0, y: 0, props: {} };

const w = (a: string, b: string, color: string): Wire => ({ id: `${a}~${b}`, a, b, color });

export interface Template {
  id: string;
  title: string;
  summary: string;
  /** Prebuilt firmware for the unchanged code in public/examples/, so templates run without a compiler. */
  hex: string;
  /** Prebuilt firmware for further boards, by board id. */
  hexes?: Record<string, string>;
  project: Project;
}

export const TEMPLATES: Template[] = [
  {
    id: 'blink',
    title: 'Blink',
    summary: 'The on-board L LED on D13. Nothing to wire.',
    hex: 'blink',
    project: { version: 1, name: 'Blink', devices: [UNO], wires: [], code: blinkIno },
  },
  {
    id: 'servo-sweep',
    title: 'Servo sweep',
    summary: 'SG90 on D9, powered from the Uno 5 V pin.',
    hex: 'servo-sweep',
    project: {
      version: 1,
      name: 'Servo sweep',
      devices: [UNO, { id: 'servo1', kind: 'servo', x: 440, y: 70, props: {} }],
      wires: [w('servo1.SIG', 'uno.D9', '#f28c1a'), w('servo1.V+', 'uno.5V', '#e53935'), w('servo1.GND', 'uno.GND1', '#1f1f1f')],
      code: servoSweepIno,
    },
  },
  {
    id: 'stepper-a4988',
    title: 'Stepper + A4988',
    summary: 'Pololu A4988, 12 V bench supply, 100 µF on VMOT, NEMA 17.',
    hex: 'stepper-a4988',
    project: {
      version: 1,
      name: 'Stepper + A4988',
      devices: [
        UNO,
        { id: 'a49881', kind: 'a4988', x: 440, y: 20, props: {} },
        { id: 'stepper1', kind: 'stepper', x: 680, y: 10, props: {} },
        { id: 'psu1', kind: 'psu', x: 640, y: 230, props: { volts: 12 } },
        { id: 'cap1', kind: 'cap', x: 560, y: 210, props: { uf: 100 } },
      ],
      wires: stepperWires(),
      code: stepperIno,
    },
  },
  {
    id: 'robot-arm',
    title: 'Two-joint robot arm',
    summary: 'Pot on A0 steers the base servo; a debounced button on D2 toggles the stepper elbow.',
    hex: 'robot-arm',
    project: {
      version: 1,
      name: 'Two-joint robot arm',
      devices: [
        UNO,
        { id: 'servo1', kind: 'servo', x: 440, y: -150, props: {} },
        { id: 'a49881', kind: 'a4988', x: 440, y: 20, props: {} },
        { id: 'stepper1', kind: 'stepper', x: 680, y: 10, props: {} },
        { id: 'psu1', kind: 'psu', x: 640, y: 230, props: { volts: 12 } },
        { id: 'cap1', kind: 'cap', x: 560, y: 210, props: { uf: 100 } },
        { id: 'button1', kind: 'button', x: 60, y: 360, props: {} },
        { id: 'pot1', kind: 'pot', x: 200, y: 340, props: {} },
      ],
      wires: [
        ...stepperWires(),
        w('servo1.SIG', 'uno.D9', '#f28c1a'),
        w('servo1.V+', 'uno.5V', '#e53935'),
        w('servo1.GND', 'uno.GND1', '#1f1f1f'),
        w('button1.1', 'uno.D2', '#f5d142'),
        w('button1.3', 'uno.GND2', '#1f1f1f'),
        w('pot1.1', 'uno.GND2', '#1f1f1f'),
        w('pot1.W', 'uno.A0', '#ffffff'),
        w('pot1.3', 'uno.5V', '#e53935'),
      ],
      code: robotArmIno,
      assembly: armAssembly as Assembly,
    },
  },
  {
    id: 'robot-hand',
    title: 'Five-finger robot hand',
    summary: 'Six SG90s on a 5 V bench supply drive tendon fingers and the wrist; pot grips, button turns the wrist.',
    hex: 'robot-hand',
    project: {
      version: 1,
      name: 'Five-finger robot hand',
      devices: [
        UNO,
        ...[1, 2, 3, 4, 5, 6].map((n): Device => ({ id: `servo${n}`, kind: 'servo', x: 430 + ((n - 1) % 2) * 190, y: -260 + Math.floor((n - 1) / 2) * 95, props: {} })),
        { id: 'psu1', kind: 'psu', x: 640, y: 120, props: { volts: 5 } },
        { id: 'button1', kind: 'button', x: 60, y: 360, props: {} },
        { id: 'pot1', kind: 'pot', x: 200, y: 340, props: {} },
      ],
      wires: [
        ...(['D3', 'D5', 'D6', 'D9', 'D10', 'D11'] as const).flatMap((pin, i) => [
          w(`servo${i + 1}.SIG`, `uno.${pin}`, '#f28c1a'),
          w(`servo${i + 1}.V+`, 'psu1.+', '#e53935'),
          w(`servo${i + 1}.GND`, 'psu1.-', '#1f1f1f'),
        ]),
        w('psu1.-', 'uno.GND1', '#1f1f1f'),
        w('button1.1', 'uno.D2', '#f5d142'),
        w('button1.3', 'uno.GND2', '#1f1f1f'),
        w('pot1.1', 'uno.GND2', '#1f1f1f'),
        w('pot1.W', 'uno.A0', '#ffffff'),
        w('pot1.3', 'uno.5V', '#e53935'),
      ],
      code: robotHandIno,
      assembly: handAssembly as Assembly,
    },
  },
  {
    id: 'dexterous-hand',
    title: 'Dexterous hand, 17 DOF',
    summary: '17 SG90s on two boards ease through 18 poses — fist, knuckles-only, hook, pinch, grasp, rock, thumbs up, a piano tap… — with finger spread, thumb opposition and a 2-axis wrist; printable servo bed.',
    hex: 'dexterous-hand',
    hexes: { uno2: 'dexterous-hand-wrist' },
    project: dexterousProject(),
  },
  {
    id: 'two-boards',
    title: 'Two boards over serial',
    summary: 'U1 sends "ping n" from its TX (D1) to the RX (D0) of U2, which toggles its L LED and prints what it got. Shared ground.',
    hex: 'serial-ping',
    hexes: { uno2: 'serial-echo' },
    project: {
      version: 1,
      name: 'Two boards over serial',
      devices: [UNO, { id: 'uno2', kind: 'uno', x: 0, y: 380, props: {} }],
      wires: [w('uno.D1', 'uno2.D0', '#3d7bff'), w('uno2.D1', 'uno.D0', '#33c46b'), w('uno.GND1', 'uno2.GND1', '#1f1f1f')],
      code: serialPingIno,
      sketches: { uno2: serialEchoIno },
    },
  },
];

/** U1 runs servos 1–11 on D2–D12 (flexion, thumb), U2 servos 12–17 on D2–D7 (spread, wrist); all on a 5 V supply. */
function dexterousProject(): Project {
  const servos: Device[] = Array.from({ length: 17 }, (_, i) => ({
    id: `servo${i + 1}`,
    kind: 'servo',
    x: 440 + (i % 3) * 190,
    y: -300 + Math.floor(i / 3) * 95,
    props: {},
  }));
  const wires: Wire[] = [];
  servos.forEach((s, i) => {
    const [board, pin] = i < 11 ? ['uno', `D${i + 2}`] : ['uno2', `D${i - 11 + 2}`];
    wires.push(w(`${s.id}.SIG`, `${board}.${pin}`, '#f28c1a'), w(`${s.id}.V+`, 'psu1.+', '#e53935'), w(`${s.id}.GND`, 'psu1.-', '#1f1f1f'));
  });
  wires.push(w('psu1.-', 'uno.GND1', '#1f1f1f'), w('psu1.-', 'uno2.GND1', '#1f1f1f'), w('uno.D1', 'uno2.D0', '#3d7bff'));
  return {
    version: 1,
    name: 'Dexterous hand, 17 DOF',
    devices: [UNO, { id: 'uno2', kind: 'uno', x: 0, y: 380, props: {} }, ...servos, { id: 'psu1', kind: 'psu', x: 1060, y: 120, props: { volts: 5 } }],
    wires,
    code: dexterousIno,
    sketches: { uno2: dexterousWristIno },
    assembly: dexterousAssembly as Assembly,
  };
}

function stepperWires(): Wire[] {
  return [
    w('a49881.STEP', 'uno.D3', '#3d7bff'),
    w('a49881.DIR', 'uno.D4', '#33c46b'),
    w('a49881.RST', 'a49881.SLP', '#9b59b6'),
    w('a49881.VDD', 'uno.5V', '#e53935'),
    w('a49881.GND', 'uno.GND3', '#1f1f1f'),
    w('a49881.VMOT', 'psu1.+', '#e53935'),
    w('a49881.GND_M', 'psu1.-', '#1f1f1f'),
    w('cap1.+', 'psu1.+', '#e53935'),
    w('cap1.-', 'psu1.-', '#1f1f1f'),
    w('a49881.1A', 'stepper1.A+', '#33c46b'),
    w('a49881.1B', 'stepper1.A-', '#1f1f1f'),
    w('a49881.2A', 'stepper1.B+', '#e53935'),
    w('a49881.2B', 'stepper1.B-', '#3d7bff'),
  ];
}


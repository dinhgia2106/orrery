// The devices on the lab shelf: their real pins, which pins are tied together inside the part, and where
// each pin sits on the 2D wiring canvas (5 canvas units per millimetre for the Uno, schematic-ish for the rest).
import { SPEC } from '../sim/catalog';

export type DeviceKind = 'uno' | 'servo' | 'a4988' | 'stepper' | 'button' | 'pot' | 'led' | 'resistor' | 'cap' | 'psu';

export interface PinDef {
  name: string;
  /** Position relative to the device's top-left corner, in canvas units. */
  x: number;
  y: number;
  /** Which way the pin label and the wire leave the part. */
  side: 'top' | 'bottom' | 'left' | 'right';
  label?: string;
  /** Present on the real part but not modelled (drawn, not connectable). */
  dummy?: boolean;
}

export interface DeviceProps {
  ohms?: number;
  volts?: number;
  uf?: number;
  color?: string;
}

export interface DeviceDef {
  kind: DeviceKind;
  title: string;
  subtitle: string;
  /** Key into CATALOG for the BOM. */
  catalog: string;
  refPrefix: string;
  w: number;
  h: number;
  pins: PinDef[];
  /** Groups of pins that are the same conductor inside the part. */
  internal?: string[][];
  defaults?: DeviceProps;
}

const MM = 5; // canvas units per mm on the Uno outline
const P = 2.54 * MM; // 0.1" header pitch

function unoPins(): PinDef[] {
  const L = SPEC.uno.lengthMm;
  const W = SPEC.uno.widthMm;
  // same (approximate) header geometry as the 3D model: D0/A5 ~5.1 mm from the right edge, 0.16" gap at D7/D8
  const right = (L - 5.1) * MM;
  const yTop = 2.5 * MM;
  const yBottom = (W - 2.5) * MM;
  const pins: PinDef[] = [];
  for (let n = 0; n <= 7; n++) pins.push({ name: `D${n}`, x: right - n * P, y: yTop, side: 'top' });
  const d8 = right - 7 * P - 4.064 * MM;
  const upper = ['D8', 'D9', 'D10', 'D11', 'D12', 'D13', 'GND3', 'AREF', 'SDA', 'SCL'];
  upper.forEach((name, i) =>
    pins.push({ name, x: d8 - i * P, y: yTop, side: 'top', label: name === 'GND3' ? 'GND' : name, dummy: name === 'AREF' }),
  );
  for (let n = 0; n <= 5; n++) pins.push({ name: `A${n}`, x: right - (5 - n) * P, y: yBottom, side: 'bottom' });
  const a0 = right - 5 * P;
  const power = ['VIN', 'GND2', 'GND1', '5V', '3V3', 'RESET', 'IOREF', 'NC'];
  power.forEach((name, i) =>
    pins.push({
      name,
      x: a0 - (2 + i) * P,
      y: yBottom,
      side: 'bottom',
      label: name.startsWith('GND') ? 'GND' : name,
      dummy: name === 'RESET' || name === 'NC',
    }),
  );
  return pins;
}

const col = (names: string[], x: number, y0: number, side: PinDef['side'], labels?: string[]): PinDef[] =>
  names.map((name, i) => ({ name, x, y: y0 + i * P, side, label: labels?.[i] }));

export const DEVICES: Record<DeviceKind, DeviceDef> = {
  uno: {
    kind: 'uno',
    title: 'Arduino UNO R3',
    subtitle: 'A000066 · ATmega328P',
    catalog: 'uno',
    refPrefix: 'U',
    w: SPEC.uno.lengthMm * MM,
    h: SPEC.uno.widthMm * MM,
    pins: unoPins(),
    // UNO R3: the GND pins are one net, IOREF is 5 V, SDA/SCL are A4/A5 brought out again
    internal: [['GND1', 'GND2', 'GND3'], ['5V', 'IOREF'], ['A4', 'SDA'], ['A5', 'SCL']],
  },
  servo: {
    kind: 'servo',
    title: 'Micro servo',
    subtitle: 'TowerPro SG90',
    catalog: 'sg90',
    refPrefix: 'M',
    w: 150,
    h: 70,
    pins: col(['GND', 'V+', 'SIG'], 0, 22, 'left', ['GND (brown)', 'V+ (red)', 'SIG (orange)']),
  },
  a4988: {
    kind: 'a4988',
    title: 'A4988 carrier',
    subtitle: 'Pololu 1182',
    catalog: 'a4988',
    refPrefix: 'U',
    w: 120,
    h: 8 * P + 24,
    pins: [
      ...col(['EN', 'MS1', 'MS2', 'MS3', 'RST', 'SLP', 'STEP', 'DIR'], 0, 18, 'left'),
      ...col(['VMOT', 'GND_M', '2B', '2A', '1A', '1B', 'VDD', 'GND'], 120, 18, 'right', ['VMOT', 'GND', '2B', '2A', '1A', '1B', 'VDD', 'GND']),
    ],
    internal: [['GND_M', 'GND']],
  },
  stepper: {
    kind: 'stepper',
    title: 'NEMA 17 stepper',
    subtitle: 'SY42STH38-1684A',
    catalog: 'nema17',
    refPrefix: 'M',
    w: 130,
    h: 130,
    pins: col(['A+', 'A-', 'B+', 'B-'], 0, 34, 'left', ['A+', 'A−', 'B+', 'B−']),
  },
  button: {
    kind: 'button',
    title: 'Tactile switch',
    subtitle: 'Omron B3F-1000',
    catalog: 'b3f',
    refPrefix: 'SW',
    w: 50,
    h: 50,
    pins: [
      { name: '1', x: 0, y: 8, side: 'left' },
      { name: '2', x: 50, y: 8, side: 'right' },
      { name: '3', x: 0, y: 42, side: 'left' },
      { name: '4', x: 50, y: 42, side: 'right' },
    ],
    // legs 1–2 and 3–4 are always connected; pressing joins the two pairs
    internal: [['1', '2'], ['3', '4']],
  },
  pot: {
    kind: 'pot',
    title: 'Potentiometer 10 kΩ',
    subtitle: 'Bourns PTV09A',
    catalog: 'ptv09',
    refPrefix: 'RV',
    w: 70,
    h: 60,
    pins: [
      { name: '1', x: 10, y: 60, side: 'bottom' },
      { name: 'W', x: 35, y: 60, side: 'bottom', label: '2 W' },
      { name: '3', x: 60, y: 60, side: 'bottom' },
    ],
  },
  led: {
    kind: 'led',
    title: 'LED 5 mm',
    subtitle: 'Kingbright WP7113ID',
    catalog: 'wp7113id',
    refPrefix: 'D',
    w: 36,
    h: 56,
    pins: [
      { name: 'A', x: 10, y: 56, side: 'bottom', label: 'A+' },
      { name: 'K', x: 26, y: 56, side: 'bottom', label: 'K−' },
    ],
    defaults: { color: '#ff3b30' },
  },
  resistor: {
    kind: 'resistor',
    title: 'Resistor',
    subtitle: '¼ W',
    catalog: 'resistor',
    refPrefix: 'R',
    w: 80,
    h: 22,
    pins: [
      { name: '1', x: 0, y: 11, side: 'left' },
      { name: '2', x: 80, y: 11, side: 'right' },
    ],
    defaults: { ohms: 220 },
  },
  cap: {
    kind: 'cap',
    title: 'Electrolytic cap',
    subtitle: 'polarised',
    catalog: 'cap',
    refPrefix: 'C',
    w: 36,
    h: 56,
    pins: [
      { name: '+', x: 10, y: 56, side: 'bottom' },
      { name: '-', x: 26, y: 56, side: 'bottom', label: '−' },
    ],
    defaults: { uf: 100 },
  },
  psu: {
    kind: 'psu',
    title: 'Bench supply',
    subtitle: 'adjustable DC',
    catalog: 'psu',
    refPrefix: 'PS',
    w: 130,
    h: 74,
    pins: [
      { name: '+', x: 40, y: 74, side: 'bottom' },
      { name: '-', x: 90, y: 74, side: 'bottom', label: '−' },
    ],
    defaults: { volts: 12 },
  },
};

/** Devices a user can add from the shelf. One board per bench for now (its id is always "uno"). */
export const SHELF: DeviceKind[] = ['uno', 'servo', 'a4988', 'stepper', 'button', 'pot', 'led', 'resistor', 'cap', 'psu'];

export function pinDef(kind: DeviceKind, pin: string): PinDef | undefined {
  return DEVICES[kind].pins.find((p) => p.name === pin);
}

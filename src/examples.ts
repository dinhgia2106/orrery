import { blinkProgram } from './sim/demos';
import type { PartSpec } from './sim/engine';
import { parseIntelHex } from './sim/hex';

export interface Example {
  id: string;
  title: string;
  summary: string;
  parts: PartSpec[];
  /** Loads the firmware; rejects with a readable message if it is not available. */
  firmware: () => Promise<Uint16Array>;
}

async function hex(name: string): Promise<Uint16Array> {
  const res = await fetch(`${import.meta.env.BASE_URL}examples/${name}.hex`);
  const text = res.ok ? await res.text() : '';
  // dev servers answer a missing file with index.html, so check the content, not only the status
  if (!text.trimStart().startsWith(':')) {
    throw new Error(`examples/${name}.hex is not built yet — run "npm run build:examples" (needs arduino-cli), or load your own .hex.`);
  }
  return parseIntelHex(text);
}

const ARM_PARTS: PartSpec[] = [
  { id: 'base', type: 'servo', pin: 'D9' },
  { id: 'elbow', type: 'stepper', step: 'D3', dir: 'D4' },
  { id: 'home', type: 'button', pin: 'D2' },
  { id: 'knob', type: 'pot', pin: 'A0' },
  { id: 'busy', type: 'led', pin: 'D13', builtin: true },
];

export const EXAMPLES: Example[] = [
  {
    id: 'blink-asm',
    title: 'Blink (hand-assembled)',
    summary: '18 words of AVR machine code toggling D13 every ~0.5 s. Runs without any compiler.',
    parts: [{ id: 'led13', type: 'led', pin: 'D13', builtin: true }],
    firmware: async () => blinkProgram(),
  },
  {
    id: 'servo-sweep',
    title: 'Servo sweep',
    summary: 'Servo library on D9 sweeps the arm base 0–180°; D13 marks the direction.',
    parts: [
      { id: 'base', type: 'servo', pin: 'D9' },
      { id: 'led13', type: 'led', pin: 'D13', builtin: true },
    ],
    firmware: () => hex('servo-sweep'),
  },
  {
    id: 'stepper-a4988',
    title: 'Stepper + A4988',
    summary: 'STEP on D3, DIR on D4: half a turn forward, half a turn back.',
    parts: [{ id: 'elbow', type: 'stepper', step: 'D3', dir: 'D4' }],
    firmware: () => hex('stepper-a4988'),
  },
  {
    id: 'robot-arm',
    title: 'Two-joint robot arm',
    summary: 'Pot on A0 steers the base servo; the button on D2 sends the elbow stepper to 90° and back.',
    parts: ARM_PARTS,
    firmware: () => hex('robot-arm'),
  },
];

export const CUSTOM_PARTS = ARM_PARTS;

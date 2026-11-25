// The Orrery design benchmark: tasks described in words, graded by the simulator. Each grader runs the
// submitted bench itself, with inputs the agent does not see, and measures what the firmware, the circuit and
// the mechanism did. Tolerances are stated next to each check.
import { Quaternion, Vector3 } from 'three';
import { runProject, type BenchInput, type RunReport, type Sample } from '../src/headless/run';
import { Netlist } from '../src/lab/circuit';
import { parseProject, type Project } from '../src/lab/project';
import { lintProject } from '../src/mcp/tools';
import type { Assembly, Joint } from '../src/mech/assembly';
import { interference, linkFrames, massProperties } from '../src/mech/physics';

export interface Criterion {
  name: string;
  pass: boolean;
  detail: string;
}

export interface Grade {
  pass: boolean;
  criteria: Criterion[];
  report?: RunReport;
}

export interface Task {
  id: string;
  title: string;
  /** What the agent is asked to build. */
  prompt: string;
  /** Simulated seconds the grader runs. */
  seconds: number;
  sampleEvery?: number;
  mechanics?: 'off' | 'static';
  /** The tester's inputs for this bench, or why they cannot be applied (e.g. there is no button). */
  inputs?: (p: Project) => BenchInput[] | string;
  grade: (p: Project, r: RunReport) => Promise<Criterion[]> | Criterion[];
}

const ofKind = (p: Project, kind: string) => p.devices.filter((d) => d.kind === kind).map((d) => d.id);

/** The last sample at or before t. */
function at(r: RunReport, t: number): Sample {
  let s = r.samples[0];
  for (const x of r.samples) if (x.t <= t + 1e-9) s = x;
  return s;
}

const crit = (name: string, pass: boolean, detail: string): Criterion => ({ name, pass, detail });
const num = (x: unknown) => (typeof x === 'number' ? x : NaN);
const presses = (p: Project, times: number[]): BenchInput[] | string => {
  const b = ofKind(p, 'button')[0];
  return b ? times.map((t) => ({ t, press: b, holdMs: 100 })) : 'there is no button on the bench';
};

/** Which boards a device's pins reach through wires (not through other parts). */
function boardsWiredTo(p: Project, device: string): string[] {
  const nets = new Netlist(p);
  const boards = new Set(ofKind(p, 'uno'));
  const out = new Set<string>();
  for (const [pin, n] of nets.netOf) {
    if (!pin.startsWith(`${device}.`)) continue;
    for (const m of nets.members[n]) {
      const owner = m.split('.')[0];
      const name = m.split('.')[1];
      if (boards.has(owner) && /^[DA]\d+$/.test(name)) out.add(owner);
    }
  }
  return [...out];
}

// ── mechanism helpers ──

/** The nearest revolute joint on the way from a link to the root. */
function hingeOf(asm: Assembly, link: string): Joint | undefined {
  const parentJoint = new Map(asm.joints.map((j) => [j.child, j]));
  for (let id: string | undefined = link, d = 0; id && d < 64; d++) {
    const j = parentJoint.get(id);
    if (!j) return undefined;
    if (j.type === 'revolute') return j;
    id = j.parent;
  }
  return undefined;
}

/** A point of a link (link frame, mm) seen from a hinge: elevation above horizontal (deg) and distance from its axis (mm). */
function fromHinge(asm: Assembly, joints: Record<string, number> | undefined, hinge: Joint, link: string, local: [number, number, number]) {
  const frames = linkFrames(asm, new Map(Object.entries(joints ?? {})));
  const point = new Vector3(...local).applyMatrix4(frames.get(link)!);
  const child = frames.get(hinge.child)!;
  const origin = new Vector3().setFromMatrixPosition(child);
  const q = new Quaternion().setFromRotationMatrix(child);
  const axis = new Vector3(...hinge.axis!).normalize().applyQuaternion(q);
  const v = point.clone().sub(origin);
  const radial = v.clone().sub(axis.clone().multiplyScalar(v.dot(axis)));
  return { elevation: (Math.asin(Math.max(-1, Math.min(1, v.y / v.length()))) * 180) / Math.PI, fromAxis: radial.length(), v };
}

export const TASKS: Task[] = [
  {
    id: 'blink-2hz',
    title: 'Blink at 2 Hz',
    prompt: "Make the Arduino Uno's on-board L LED (pin 13) blink at 2 Hz: 250 ms on, 250 ms off, forever. Nothing needs to be wired besides the board.",
    seconds: 3,
    sampleEvery: 0.005,
    mechanics: 'off',
    grade: (p, r) => {
      const board = ofKind(p, 'uno')[0];
      if (!board) return [crit('a board', false, 'no Arduino Uno on the bench')];
      const toggles: number[] = [];
      let last: unknown;
      for (const s of r.samples) {
        const l = s.devices[board]?.L;
        if (last !== undefined && l !== last) toggles.push(s.t);
        last = l;
      }
      const gaps = toggles.slice(1).map((t, i) => (t - toggles[i]) * 1000);
      const bad = gaps.filter((g) => Math.abs(g - 250) > 15);
      return [
        crit('blinks', gaps.length >= 8, `${toggles.length} toggles in ${r.simulatedSec} s (need ≥ 9)`),
        crit('250 ms ± 15 ms per half period', gaps.length > 0 && bad.length === 0, `half periods (ms): ${gaps.map((g) => g.toFixed(0)).join(', ') || 'none'}`),
      ];
    },
  },
  {
    id: 'button-toggle-led',
    title: 'Button toggles an LED',
    prompt:
      'Add a push button and a red LED to an Arduino Uno. Each press of the button toggles the LED; it is off at power-up. Use a series resistor so neither the pin nor the LED is over-driven. The button is a real one: its contacts bounce. The tester presses it several times, about a second apart.',
    seconds: 3,
    mechanics: 'off',
    inputs: (p) => presses(p, [0.5, 1.5, 2.5]),
    grade: (p, r) => {
      const led = ofKind(p, 'led')[0];
      if (!led) return [crit('an LED', false, 'no LED on the bench')];
      const lit = (t: number) => at(r, t).devices[led]?.lit === true;
      const want: [number, boolean][] = [
        [0.4, false],
        [1.3, true],
        [2.3, false],
        [2.95, true],
      ];
      return want.map(([t, on]) => crit(`LED ${on ? 'on' : 'off'} at ${t} s`, lit(t) === on, `${led} is ${lit(t) ? 'lit' : 'dark'} (presses at 0.5, 1.5, 2.5 s)`));
    },
  },
  {
    id: 'pot-servo',
    title: 'Potentiometer steers a servo',
    prompt:
      "An SG90 servo follows a 10 kΩ potentiometer: one end of the pot's travel puts the servo at 0°, the other end at 180°, the middle at 90°, linearly in between. The servo may be powered from the Uno's 5 V pin.",
    seconds: 3,
    mechanics: 'off',
    inputs: (p) => {
      const pot = ofKind(p, 'pot')[0];
      return pot
        ? [
            { t: 0, pot, value: 0 },
            { t: 1, pot, value: 1 },
            { t: 2, pot, value: 0.5 },
          ]
        : 'there is no potentiometer on the bench';
    },
    grade: (p, r) => {
      const servo = ofKind(p, 'servo')[0];
      if (!servo) return [crit('a servo', false, 'no servo on the bench')];
      const a = (t: number) => num(at(r, t).devices[servo]?.angle);
      const [lo, hi, mid] = [a(0.95), a(1.95), a(2.95)];
      const ends = (lo <= 5 && hi >= 175) || (hi <= 5 && lo >= 175);
      return [
        crit('pot ends give 0° and 180° (±5°)', ends, `pot 0 → ${lo.toFixed(1)}°, pot 1 → ${hi.toFixed(1)}°`),
        crit('pot middle gives 90° (±5°)', Math.abs(mid - 90) <= 5, `pot 0.5 → ${mid.toFixed(1)}°`),
      ];
    },
  },
  {
    id: 'serial-pong',
    title: 'Serial ping → pong',
    prompt:
      'Program an Arduino Uno that prints the line `ready` once at start-up (9600 baud), then answers every received line that is exactly `ping` with the line `pong`. Other lines get no answer. Received lines end with "\\n".',
    seconds: 2,
    mechanics: 'off',
    inputs: (p) => {
      const board = ofKind(p, 'uno')[0];
      return board
        ? [
            { t: 0.5, serial: 'ping\n', board },
            { t: 1.0, serial: 'hello\n', board },
            { t: 1.5, serial: 'ping\n', board },
          ]
        : 'there is no board on the bench';
    },
    grade: (p, r) => {
      const board = ofKind(p, 'uno')[0];
      const lines = (r.serial[board] ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      return [crit('serial output is ready, pong, pong', JSON.stringify(lines) === JSON.stringify(['ready', 'pong', 'pong']), `got ${JSON.stringify(lines)} (sent ping, hello, ping)`)];
    },
  },
  {
    id: 'stepper-one-rev',
    title: 'Stepper: exactly one revolution',
    prompt:
      "Turn a NEMA 17 stepper (200 full steps per revolution) exactly one revolution after power-up, then stop and hold position. Drive it with an A4988 carrier powered from a 12 V bench supply, with the capacitor Pololu recommends across VMOT. Don't lose steps.",
    seconds: 3,
    mechanics: 'off',
    grade: (p, r) => {
      const motor = ofKind(p, 'stepper')[0];
      const driver = ofKind(p, 'a4988')[0];
      if (!motor || !driver) return [crit('a stepper and an A4988', false, 'missing on the bench')];
      const end = num(r.final[motor]?.angle);
      const before = num(at(r, 2.5).devices[motor]?.angle);
      const warns = r.checks.filter((c) => c.level === 'warn' && /lost|µF|reversed/.test(c.msg));
      return [
        crit('one revolution (±1.8°)', Math.abs(Math.abs(end) - 360) <= 1.8, `final angle ${end}°`),
        crit('stopped by 2.5 s', before === end, `angle at 2.5 s ${before}°, at 3 s ${end}°`),
        crit('driver enabled at the end (holding)', r.final[driver]?.enabled === true, `enabled: ${String(r.final[driver]?.enabled)}`),
        crit('no lost steps, VMOT capacitor in place', warns.length === 0, warns.map((w) => w.msg).join(' | ') || 'none'),
      ];
    },
  },
  {
    id: 'two-board-relay',
    title: 'Two boards: button on one, LED on the other',
    prompt:
      'Two Arduino Unos. A push button is wired to the first. Every press of the button toggles the on-board L LED (pin 13) of the second board; it is off at power-up. The boards talk over serial (TX → RX). The button bounces; presses come about a second apart.',
    seconds: 2.5,
    mechanics: 'off',
    inputs: (p) => presses(p, [0.5, 1.5]),
    grade: (p, r) => {
      const boards = ofKind(p, 'uno');
      const button = ofKind(p, 'button')[0];
      if (boards.length < 2 || !button) return [crit('two boards and a button', false, `${boards.length} board(s), button: ${button ?? 'none'}`)];
      const own = boardsWiredTo(p, button);
      const others = boards.filter((b) => !own.includes(b));
      const L = (b: string, t: number) => at(r, t).devices[b]?.L === true;
      const ok = others.find((b) => !L(b, 0.4) && L(b, 1.3) && !L(b, 2.3));
      return [
        crit('button on one board', own.length === 1, `button reaches ${own.join(', ') || 'no board'}`),
        crit('the other board toggles L per press', !!ok, others.map((b) => `${b}: ${[0.4, 1.3, 2.3].map((t) => (L(b, t) ? 'on' : 'off')).join('/')}`).join('; ') + ' at 0.4/1.3/2.3 s'),
      ];
    },
  },
  {
    id: 'arm-lift',
    title: 'One-joint arm: horizontal ↔ vertical',
    prompt:
      'Build a one-joint arm (with an Orrery assembly): a PLA bar 100 × 10 × 10 mm, hinged at one end to a fixed base and turned by an SG90 servo. At power-up the bar is horizontal. Each press of a push button swaps it between horizontal and pointing straight up. No parts may overlap and the servo must be able to hold the bar.',
    seconds: 2.5,
    mechanics: 'static',
    inputs: (p) => presses(p, [0.5, 1.5]),
    grade: (p, r) => {
      const asm = p.assembly;
      if (!asm) return [crit('an assembly', false, 'the project has no (valid) assembly')];
      const bar = asm.links.find((l) => 'box' in l.shape && [...l.shape.box].sort((a, b) => a - b).every((x, i) => Math.abs(x - [10, 10, 100][i]) <= 0.5) && (l.material ?? 'PLA') === 'PLA');
      if (!bar) return [crit('a 100 × 10 × 10 mm PLA bar', false, 'no such link')];
      const hinge = hingeOf(asm, bar.id);
      if (!hinge) return [crit('the bar is hinged', false, `no revolute joint above ${bar.id}`)];
      const view = (t: number) => fromHinge(asm, at(r, t).joints, hinge, bar.id, (bar.position ?? [0, 0, 0]) as [number, number, number]);
      const [a, b, c] = [view(0.4), view(1.4), view(2.4)];
      return [
        crit('hinged at one end (centre 50 ± 5 mm from the axis)', Math.abs(a.fromAxis - 50) <= 5, `${a.fromAxis.toFixed(1)} mm`),
        crit('horizontal at power-up (±5°)', Math.abs(a.elevation) <= 5, `${a.elevation.toFixed(1)}°`),
        crit('straight up after the first press (≥ 85°)', b.elevation >= 85, `${b.elevation.toFixed(1)}°`),
        crit('horizontal again after the second press (±5°)', Math.abs(c.elevation) <= 5, `${c.elevation.toFixed(1)}°`),
      ];
    },
  },
  {
    id: 'heavy-lift',
    title: 'Lift 250 g by 45° with an SG90',
    prompt:
      "An arm lifts a 250 g weight whose centre is 90 mm from the hinge axis. At power-up the arm is horizontal; one press of a push button raises it by 45° and holds it there. An SG90 servo does the lifting and its load must stay under 80% of its stall torque at all times — the weight alone is more than an SG90 can hold at 90 mm, so plan a reduction. Model the weight as a link with \"massG\": 250 in the Orrery assembly.",
    seconds: 1.5,
    mechanics: 'static',
    inputs: (p) => presses(p, [0.5]),
    grade: async (p, r) => {
      const asm = p.assembly;
      if (!asm) return [crit('an assembly', false, 'the project has no (valid) assembly')];
      const props = await massProperties(asm);
      const weight = [...props].find(([, m]) => m.massG >= 250 && m.massG <= 260);
      if (!weight) return [crit('a 250 g weight', false, 'no link of 250 g')];
      const [id, mp] = weight;
      const hinge = hingeOf(asm, id);
      if (!hinge) return [crit('the weight is on a hinge', false, `no revolute joint above ${id}`)];
      const view = (t: number) => fromHinge(asm, at(r, t).joints, hinge, id, mp.com as [number, number, number]);
      const [rest, up] = [view(0.4), view(1.45)];
      const lift = (Math.acos(Math.max(-1, Math.min(1, rest.v.clone().normalize().dot(up.v.clone().normalize())))) * 180) / Math.PI;
      const servo = r.mechanics?.actuators.find((x) => ofKind(p, 'servo').includes(x.device));
      return [
        crit('weight 90 ± 2 mm from the hinge axis', Math.abs(rest.fromAxis - 90) <= 2, `${rest.fromAxis.toFixed(1)} mm`),
        crit('horizontal at power-up (±5°)', Math.abs(rest.elevation) <= 5, `${rest.elevation.toFixed(1)}°`),
        crit('raised by 45° ± 3°', Math.abs(lift - 45) <= 3 && up.v.y > rest.v.y, `turned ${lift.toFixed(1)}°, elevation ${up.elevation.toFixed(1)}°`),
        crit('SG90 under 80% of stall torque', !!servo && servo.peakShare < 0.8, servo ? `peak ${(servo.peakShare * 100).toFixed(0)}% of ${servo.limitKgfCm} kgf·cm` : 'no servo carries the load'),
      ];
    },
  },

  // ── timing and output ──
  {
    id: 'sos-morse',
    title: 'SOS in Morse code',
    prompt:
      "Blink SOS in Morse code on the Uno's on-board L LED (pin 13), repeating forever: a dot is 200 ms on, a dash 600 ms on, 200 ms off between the marks of a letter, 600 ms off between letters and 1400 ms off before the message repeats. Start with the first dot at power-up.",
    seconds: 7.6,
    sampleEvery: 0.005,
    mechanics: 'off',
    grade: (p, r) => {
      const board = ofKind(p, 'uno')[0];
      if (!board) return [crit('a board', false, 'no Arduino Uno on the bench')];
      const runs = levelRuns(r, (s) => s.devices[board]?.L === true);
      const ons = runs.filter((x) => x.level).map((x) => x.ms);
      const offs = runs.filter((x) => !x.level).map((x) => x.ms);
      const wantOn = [200, 200, 200, 600, 600, 600, 200, 200, 200];
      const wantOff = [200, 200, 600, 200, 200, 600, 200, 200, 1400];
      return [
        crit('marks: dot dot dot dash dash dash dot dot dot (±20 ms)', within(ons.slice(0, 9), wantOn, 20), `on (ms): ${ons.slice(0, 9).join(', ')}`),
        crit('gaps 200/600/1400 ms (±20 ms)', within(offs.slice(0, 9), wantOff, 20), `off (ms): ${offs.slice(0, 9).join(', ')}`),
      ];
    },
  },
  {
    id: 'pwm-fade',
    title: 'LED fades in and out',
    prompt:
      'An LED with a series resistor on an Arduino Uno fades smoothly from off to full brightness over 1 s, then back to off over 1 s, and repeats (a 2 s cycle). Use PWM.',
    seconds: 6.5,
    sampleEvery: 0.02,
    mechanics: 'off',
    grade: (p, r) => {
      const led = ofKind(p, 'led')[0];
      if (!led) return [crit('an LED', false, 'no LED on the bench')];
      const xs = r.samples.filter((s) => s.t >= 0.5).map((s) => ({ t: s.t, ma: num(s.devices[led]?.mA) }));
      const max = Math.max(...xs.map((x) => x.ma));
      const min = Math.min(...xs.map((x) => x.ma));
      const ups = xs.slice(1).filter((x, i) => xs[i].ma < max / 2 && x.ma >= max / 2).map((x) => x.t);
      const periods = ups.slice(1).map((t, i) => t - ups[i]);
      const mid = xs.filter((x) => x.ma > 0.2 * max && x.ma < 0.8 * max).length / xs.length;
      return [
        crit('lights up (≥ 5 mA at the brightest) and goes dark (≤ 10% of that)', max >= 5 && min <= 0.1 * max, `${min.toFixed(1)}–${max.toFixed(1)} mA`),
        crit('2 s cycle (±0.1 s)', periods.length >= 2 && periods.every((d) => Math.abs(d - 2) <= 0.1), `cycles (s): ${periods.map((d) => d.toFixed(2)).join(', ') || 'none'}`),
        crit('fades (≥ 40% of the time between 20% and 80% brightness)', mid >= 0.4, `${Math.round(mid * 100)}% of the time`),
      ];
    },
  },
  {
    id: 'traffic-light',
    title: 'Traffic light',
    prompt:
      'A traffic light: three LEDs with series resistors on an Arduino Uno, with device ids "red", "yellow" and "green". From power-up: green for 3 s, yellow for 1 s, red for 3 s, then again from green, forever. Exactly one LED is lit at a time.',
    seconds: 11.5,
    mechanics: 'off',
    grade: (p, r) => {
      const ids = ['red', 'yellow', 'green'];
      const missing = ids.filter((id) => !p.devices.some((d) => d.id === id && d.kind === 'led'));
      if (missing.length) return [crit('LEDs red, yellow, green', false, `missing: ${missing.join(', ')}`)];
      const lit = (t: number) => ids.filter((id) => at(r, t).devices[id]?.lit === true);
      const want: [number, string][] = [
        [1.5, 'green'],
        [2.9, 'green'],
        [3.1, 'yellow'],
        [3.9, 'yellow'],
        [4.1, 'red'],
        [6.9, 'red'],
        [7.1, 'green'],
        [9.9, 'green'],
        [10.5, 'yellow'],
      ];
      const bad = want.filter(([t, id]) => lit(t).join() !== id);
      return [crit('green 3 s, yellow 1 s, red 3 s, one at a time (±0.1 s)', bad.length === 0, bad.map(([t, id]) => `${t} s: want ${id}, lit ${lit(t).join('+') || 'none'}`).join('; ') || 'all as expected')];
    },
  },
  {
    id: 'button-counter-serial',
    title: 'Count presses over serial',
    prompt:
      'A push button on an Arduino Uno. Each press prints a line "count: N" on the serial port (9600 baud), N counting from 1. Nothing else is printed. The button bounces; presses come about half a second apart.',
    seconds: 2.5,
    mechanics: 'off',
    inputs: (p) => presses(p, [0.5, 1.0, 1.5, 2.0]),
    grade: (p, r) => {
      const got = lines(r, ofKind(p, 'uno')[0]);
      const want = ['count: 1', 'count: 2', 'count: 3', 'count: 4'];
      return [crit('four presses print count: 1 … count: 4', same(got, want), `got ${JSON.stringify(got)}`)];
    },
  },
  {
    id: 'long-press',
    title: 'Short press toggles, long press turns off',
    prompt:
      'An LED with a series resistor and a push button on an Arduino Uno; the LED is off at power-up. A short press (released within 0.5 s) toggles the LED. Holding the button for 1 s turns the LED off at that moment, and releasing it afterwards changes nothing. The button bounces.',
    seconds: 5.2,
    mechanics: 'off',
    inputs: (p) => {
      const b = ofKind(p, 'button')[0];
      return b
        ? [
            { t: 0.5, press: b, holdMs: 100 },
            { t: 1.5, press: b, holdMs: 1500 },
            { t: 3.5, press: b, holdMs: 100 },
            { t: 4.5, press: b, holdMs: 100 },
          ]
        : 'there is no button on the bench';
    },
    grade: (p, r) => {
      const led = ofKind(p, 'led')[0];
      if (!led) return [crit('an LED', false, 'no LED on the bench')];
      return checkpoints(r, led, 'lit', [
        [1.2, true, 'after a short press'],
        [2.0, true, 'held 0.5 s: nothing yet'],
        [2.7, false, 'held over 1 s: off'],
        [3.2, false, 'released after the long press: still off'],
        [4.2, true, 'short press'],
        [5.0, false, 'short press'],
      ]);
    },
  },
  {
    id: 'pot-threshold',
    title: 'Threshold with hysteresis',
    prompt:
      'A 10 kΩ potentiometer (pin 1 to GND, pin 3 to 5 V, wiper to an analog input) and an LED with a series resistor on an Arduino Uno. The LED turns on when the wiper rises above 3.0 V and off when it falls below 2.0 V; in between it keeps whatever state it had.',
    seconds: 5,
    mechanics: 'off',
    inputs: (p) => {
      const pot = ofKind(p, 'pot')[0];
      return pot ? [0.3, 0.7, 0.5, 0.3, 0.5].map((value, i) => ({ t: i, pot, value })) : 'there is no potentiometer on the bench';
    },
    grade: (p, r) => {
      const led = ofKind(p, 'led')[0];
      if (!led) return [crit('an LED', false, 'no LED on the bench')];
      return checkpoints(r, led, 'lit', [
        [0.9, false, 'wiper 1.5 V'],
        [1.9, true, 'wiper 3.5 V'],
        [2.9, true, 'wiper 2.5 V after 3.5 V'],
        [3.9, false, 'wiper 1.5 V'],
        [4.9, false, 'wiper 2.5 V after 1.5 V'],
      ]);
    },
  },

  // ── serial protocols ──
  {
    id: 'serial-led-command',
    title: 'Serial commands for the LED',
    prompt:
      'An Arduino Uno at 9600 baud reads lines ending in "\\n". "on" and "off" switch its on-board L LED (pin 13), "toggle" flips it; each is answered with the line "ok". Any other line is answered "error" and changes nothing. The LED is off at power-up and nothing is printed at start-up.',
    seconds: 1.8,
    mechanics: 'off',
    inputs: (p) => {
      const board = ofKind(p, 'uno')[0];
      return board ? ['on', 'blink', 'toggle', 'toggle', 'off'].map((cmd, i) => ({ t: 0.3 * (i + 1), serial: `${cmd}\n`, board })) : 'there is no board on the bench';
    },
    grade: (p, r) => {
      const board = ofKind(p, 'uno')[0];
      const got = lines(r, board);
      return [
        crit('answers ok, error, ok, ok, ok', same(got, ['ok', 'error', 'ok', 'ok', 'ok']), `got ${JSON.stringify(got)} (sent on, blink, toggle, toggle, off)`),
        ...checkpoints(r, board, 'L', [
          [0.5, true, 'on'],
          [0.8, true, 'unknown command'],
          [1.1, false, 'toggle'],
          [1.4, true, 'toggle'],
          [1.7, false, 'off'],
        ]),
      ];
    },
  },
  {
    id: 'serial-servo-command',
    title: 'Serial angle commands for a servo',
    prompt:
      'An SG90 servo on an Arduino Uno (9600 baud). A received line holding a whole number from 0 to 180 moves the servo to that angle and is answered "angle N". Any other line (out of range, not a number) is answered "error" and the servo stays where it is. Lines end in "\\n".',
    seconds: 2.4,
    mechanics: 'off',
    inputs: (p) => {
      const board = ofKind(p, 'uno')[0];
      return board ? ['30', '150', '200', 'abc', '90'].map((cmd, i) => ({ t: 0.2 + 0.4 * i, serial: `${cmd}\n`, board })) : 'there is no board on the bench';
    },
    grade: (p, r) => {
      const servo = ofKind(p, 'servo')[0];
      if (!servo) return [crit('a servo', false, 'no servo on the bench')];
      return [
        crit('answers angle 30, angle 150, error, error, angle 90', same(lines(r, ofKind(p, 'uno')[0]), ['angle 30', 'angle 150', 'error', 'error', 'angle 90']), `got ${JSON.stringify(lines(r, ofKind(p, 'uno')[0]))}`),
        ...angleCheckpoints(r, servo, [
          [0.55, 30, 2],
          [0.95, 150, 2],
          [1.75, 150, 2],
          [2.35, 90, 2],
        ]),
      ];
    },
  },
  {
    id: 'serial-adc-read',
    title: 'Read the ADC on request',
    prompt:
      'A 10 kΩ potentiometer (pin 1 to GND, pin 3 to 5 V) with its wiper on A0 of an Arduino Uno. When the Uno receives the line "read" (9600 baud, lines end in "\\n") it answers with one line: the raw analogRead(A0) value as a decimal number. Nothing else is printed.',
    seconds: 1.6,
    mechanics: 'off',
    inputs: (p) => {
      const pot = ofKind(p, 'pot')[0];
      const board = ofKind(p, 'uno')[0];
      if (!pot || !board) return 'needs a potentiometer and a board';
      return [
        { t: 0, pot, value: 0.25 },
        { t: 0.3, serial: 'read\n', board },
        { t: 0.5, pot, value: 0.75 },
        { t: 0.8, serial: 'read\n', board },
        { t: 1.0, pot, value: 1 },
        { t: 1.3, serial: 'read\n', board },
      ];
    },
    grade: (p, r) => {
      const got = lines(r, ofKind(p, 'uno')[0]).map(Number);
      const want = [256, 767, 1023];
      return [crit('answers ≈ 256, 767, 1023 (±4 counts)', got.length === 3 && got.every((x, i) => Math.abs(x - want[i]) <= 4), `got ${JSON.stringify(lines(r, ofKind(p, 'uno')[0]))} for the wiper at 1/4, 3/4 and the top`)];
    },
  },

  // ── circuits ──
  {
    id: 'led-from-psu',
    title: 'LED on a 9 V supply, no Arduino',
    prompt:
      'Light a red LED (Kingbright WP7113ID) from a 9 V bench supply with no Arduino on the bench. Choose the series resistor so the LED carries 10 mA (±1 mA).',
    seconds: 0.2,
    mechanics: 'off',
    grade: (p, r) => {
      const led = ofKind(p, 'led')[0];
      const psu = p.devices.find((d) => d.kind === 'psu');
      return [
        crit('no Arduino', ofKind(p, 'uno').length === 0, `${ofKind(p, 'uno').length} board(s)`),
        crit('a 9 V supply', psu?.props.volts === 9, `supply: ${psu ? `${psu.props.volts} V` : 'none'}`),
        crit('LED at 10 ± 1 mA', !!led && Math.abs(num(r.final[led]?.mA) - 10) <= 1, led ? `${r.final[led]?.mA} mA` : 'no LED'),
      ];
    },
  },
  {
    id: 'divider-adc',
    title: 'Voltage divider into the ADC',
    prompt:
      "Two resistors, each at least 1 kΩ, divide the Uno's 5 V down to 2.0 V (±0.05 V) on A0. The sketch prints the voltage it measures on A0 in millivolts once per second as a line \"mV=<n>\" (9600 baud).",
    seconds: 2.5,
    mechanics: 'off',
    grade: (p, r) => {
      const rs = p.devices.filter((d) => d.kind === 'resistor');
      const last = lines(r, ofKind(p, 'uno')[0]).at(-1) ?? '';
      const mv = Number(/^mV=(-?\d+)$/.exec(last)?.[1]);
      return [
        crit('two resistors of at least 1 kΩ', rs.length >= 2 && rs.every((d) => (d.props.ohms ?? 220) >= 1000), rs.map((d) => `${d.id} ${d.props.ohms ?? 220} Ω`).join(', ') || 'none'),
        crit('measures 2000 ± 50 mV', Math.abs(mv - 2000) <= 50, `last line: ${JSON.stringify(last)}`),
      ];
    },
  },

  // ── servos ──
  {
    id: 'two-servos-mirror',
    title: 'Two servos mirror a pot',
    prompt:
      'A 10 kΩ potentiometer (pin 1 to GND, pin 3 to 5 V, wiper to A0) and two SG90 servos with device ids "servo1" and "servo2". servo1 follows the pot from 0° (pot at GND) to 180° (pot at 5 V); servo2 always sits at the mirror angle, 180° minus servo1. Power both servos from a 5 V bench supply, not from the Uno.',
    seconds: 3,
    mechanics: 'off',
    inputs: (p) => {
      const pot = ofKind(p, 'pot')[0];
      return pot
        ? [
            { t: 0, pot, value: 0 },
            { t: 1, pot, value: 1 },
            { t: 2, pot, value: 0.25 },
          ]
        : 'there is no potentiometer on the bench';
    },
    grade: (p, r) => {
      if (!['servo1', 'servo2'].every((id) => p.devices.some((d) => d.id === id && d.kind === 'servo'))) return [crit('servo1 and servo2', false, 'missing')];
      return [
        ...angleCheckpoints(r, 'servo1', [
          [0.95, 0, 5],
          [1.95, 180, 5],
          [2.95, 45, 5],
        ]),
        ...angleCheckpoints(r, 'servo2', [
          [0.95, 180, 5],
          [1.95, 0, 5],
          [2.95, 135, 5],
        ]),
        servosOnSupply(p, ['servo1', 'servo2']),
      ];
    },
  },
  {
    id: 'servo-slow-sweep',
    title: 'Slow, even servo sweep',
    prompt:
      'An SG90 on an Arduino Uno sweeps from 0° to 180° in 3 s at a constant speed, then back to 0° in 3 s, forever, starting at 0° at power-up. (The servo itself would turn much faster; the sketch must pace it.)',
    seconds: 7,
    mechanics: 'off',
    grade: (p, r) => {
      const servo = ofKind(p, 'servo')[0];
      if (!servo) return [crit('a servo', false, 'no servo on the bench')];
      const tri = (t: number) => {
        const u = t % 6;
        return u < 3 ? 60 * u : 180 - 60 * (u - 3);
      };
      const off = r.samples.filter((s) => s.t >= 0.5).map((s) => ({ t: s.t, d: Math.abs(num(s.devices[servo]?.angle) - tri(s.t)) }));
      const worst = off.reduce((a, b) => (b.d > a.d ? b : a), { t: 0, d: 0 });
      return [crit('follows 60°/s up and down (±8°)', worst.d <= 8, `largest gap ${worst.d.toFixed(1)}° at ${worst.t} s`)];
    },
  },
  {
    id: 'six-servo-supply',
    title: 'Six servos on a bench supply',
    prompt:
      "Six SG90 servos on one Arduino Uno move together: all at 0° for 1 s, all at 180° for 1 s, repeating, starting at 0° at power-up. Together they draw more than the Uno's USB supply can give: power them from a 5 V bench supply and give it a common ground with the Uno.",
    seconds: 3,
    mechanics: 'off',
    grade: (p, r) => {
      const servos = ofKind(p, 'servo');
      if (servos.length < 6) return [crit('six servos', false, `${servos.length} servo(s)`)];
      const all = (t: number, ok: (a: number) => boolean) => servos.every((id) => ok(num(at(r, t).devices[id]?.angle)));
      return [
        crit('all at 0° at 0.9 s, 180° at 1.9 s, 0° at 2.9 s (±5°)', all(0.9, (a) => a <= 5) && all(1.9, (a) => a >= 175) && all(2.9, (a) => a <= 5), servos.map((id) => `${id}: ${[0.9, 1.9, 2.9].map((t) => num(at(r, t).devices[id]?.angle).toFixed(0)).join('/')}`).join('; ')),
        servosOnSupply(p, servos),
      ];
    },
  },

  // ── steppers ──
  {
    id: 'stepper-pot-position',
    title: 'Stepper follows a pot',
    prompt:
      "A NEMA 17 stepper on an A4988 (12 V bench supply, the VMOT capacitor Pololu recommends) follows a 10 kΩ potentiometer (pin 1 to GND, pin 3 to 5 V, wiper to an analog input): the shaft's power-up position is 0°, the pot at GND means 0° and at 5 V half a turn (180°), linearly in between. The pot may be anywhere at power-up. Don't lose steps.",
    seconds: 5,
    mechanics: 'off',
    inputs: (p) => {
      const pot = ofKind(p, 'pot')[0];
      return pot
        ? [
            { t: 0.5, pot, value: 1 },
            { t: 2, pot, value: 0.25 },
            { t: 3.5, pot, value: 0 },
          ]
        : 'there is no potentiometer on the bench';
    },
    grade: (p, r) => {
      const motor = ofKind(p, 'stepper')[0];
      if (!motor) return [crit('a stepper', false, 'no stepper on the bench')];
      const a = (t: number) => num(at(r, t).devices[motor]?.angle);
      const s = Math.sign(a(1.9)) || 1;
      return [
        ...[
          [0.45, 90, 'pot at mid-travel since power-up'],
          [1.9, 180, 'pot at 5 V'],
          [3.4, 45, 'pot at 1/4'],
          [4.9, 0, 'pot at GND'],
        ].map(([t, want, why]) => crit(`${want}° at ${t} s (±3.6°)`, Math.abs(a(t as number) - s * (want as number)) <= 3.6, `${a(t as number)}° (${why})`)),
        noStepperTrouble(r),
      ];
    },
  },
  {
    id: 'stepper-button-jog',
    title: 'Quarter turn per press',
    prompt:
      'A NEMA 17 stepper on an A4988 (12 V bench supply, the VMOT capacitor Pololu recommends) and a push button on an Arduino Uno. Each press turns the shaft exactly a quarter turn, always in the same direction. The button bounces; presses come about a second apart.',
    seconds: 3.5,
    mechanics: 'off',
    inputs: (p) => presses(p, [0.5, 1.5, 2.5]),
    grade: (p, r) => {
      const motor = ofKind(p, 'stepper')[0];
      if (!motor) return [crit('a stepper', false, 'no stepper on the bench')];
      const a = (t: number) => num(at(r, t).devices[motor]?.angle);
      const s = Math.sign(a(1.4)) || 1;
      return [
        crit('90°, 180°, 270° after the presses, one direction (±1.8°)', [1.4, 2.4, 3.4].every((t, i) => Math.abs(a(t) - s * 90 * (i + 1)) <= 1.8), `${[0.4, 1.4, 2.4, 3.4].map((t) => `${a(t)}°`).join(' → ')}`),
        noStepperTrouble(r),
      ];
    },
  },
  {
    id: 'stepper-microstep',
    title: 'One revolution in 1/16 microsteps',
    prompt:
      'Turn a NEMA 17 stepper exactly one revolution after power-up using the A4988 in 1/16 microstep mode, then stop and hold. 12 V bench supply with the VMOT capacitor Pololu recommends.',
    seconds: 4.5,
    mechanics: 'off',
    grade: (p, r) => {
      const motor = ofKind(p, 'stepper')[0];
      const driver = ofKind(p, 'a4988')[0];
      if (!motor || !driver) return [crit('a stepper and an A4988', false, 'missing on the bench')];
      const end = num(r.final[motor]?.angle);
      return [
        crit('1/16 microstep mode', r.final[driver]?.microsteps === 16, `driver in 1/${String(r.final[driver]?.microsteps)} steps`),
        crit('one revolution (±0.3°)', Math.abs(Math.abs(end) - 360) <= 0.3, `final angle ${end}°`),
        crit('stopped by 4 s', num(at(r, 4).devices[motor]?.angle) === end, `${num(at(r, 4).devices[motor]?.angle)}° at 4 s, ${end}° at 4.5 s`),
        noStepperTrouble(r),
      ];
    },
  },
  {
    id: 'stepper-speed',
    title: 'Stepper at 60 rpm',
    prompt: 'A NEMA 17 stepper on an A4988 (12 V bench supply, the VMOT capacitor Pololu recommends) turns continuously at exactly 60 rpm, starting at power-up.',
    seconds: 3.2,
    mechanics: 'off',
    grade: (p, r) => {
      const motor = ofKind(p, 'stepper')[0];
      if (!motor) return [crit('a stepper', false, 'no stepper on the bench')];
      const d1 = num(at(r, 2).devices[motor]?.angle) - num(at(r, 1).devices[motor]?.angle);
      const d2 = num(at(r, 3).devices[motor]?.angle) - num(at(r, 2).devices[motor]?.angle);
      return [crit('360°/s in each of two seconds (±1%)', [d1, d2].every((d) => Math.abs(Math.abs(d) - 360) <= 3.6) && Math.sign(d1) === Math.sign(d2), `${d1.toFixed(1)}° from 1 to 2 s, ${d2.toFixed(1)}° from 2 to 3 s`), noStepperTrouble(r)];
    },
  },

  // ── several boards ──
  {
    id: 'two-board-servo',
    title: 'Pot on one board, servo on the other',
    prompt:
      'Two Arduino Unos. A 10 kΩ potentiometer (pin 1 to GND, pin 3 to 5 V, wiper to an analog input) is on the first board, an SG90 servo on the second. The servo follows the pot: 0° with the pot at GND, 180° at 5 V, linearly between. The boards talk over serial (TX → RX).',
    seconds: 3,
    mechanics: 'off',
    inputs: (p) => {
      const pot = ofKind(p, 'pot')[0];
      return pot
        ? [
            { t: 0, pot, value: 0 },
            { t: 1, pot, value: 1 },
            { t: 2, pot, value: 0.5 },
          ]
        : 'there is no potentiometer on the bench';
    },
    grade: (p, r) => {
      const pot = ofKind(p, 'pot')[0];
      const servo = ofKind(p, 'servo')[0];
      if (!servo || ofKind(p, 'uno').length < 2) return [crit('two boards and a servo', false, 'missing')];
      const potBoards = boardsWiredTo(p, pot);
      const servoBoards = boardsWiredTo(p, servo);
      return [
        crit('pot and servo on different boards', potBoards.length === 1 && servoBoards.length === 1 && potBoards[0] !== servoBoards[0], `pot on ${potBoards.join(',') || 'none'}, servo on ${servoBoards.join(',') || 'none'}`),
        ...angleCheckpoints(r, servo, [
          [0.95, 0, 5],
          [1.95, 180, 5],
          [2.95, 90, 5],
        ]),
      ];
    },
  },

  // ── mechanisms ──
  {
    id: 'gripper-close',
    title: 'Two-finger gripper on one servo',
    prompt:
      'A two-finger gripper (Orrery assembly): two fingers on hinges on a palm, both driven by ONE SG90 (couple the second finger to the first). Put a small fingertip pad link at the tip of each finger, with link ids "pad1" and "pad2". At power-up the gripper is open, pad centres at least 30 mm apart; each press of a push button closes it (pad centres at most 10 mm apart, fingers not overlapping) or opens it again.',
    seconds: 2.5,
    mechanics: 'static',
    inputs: (p) => presses(p, [0.5, 1.5]),
    grade: async (p, r) => {
      const asm = p.assembly;
      if (!asm) return [crit('an assembly', false, 'the project has no (valid) assembly')];
      if (!['pad1', 'pad2'].every((id) => asm.links.some((l) => l.id === id))) return [crit('links pad1 and pad2', false, 'missing')];
      const gap = (t: number) => {
        const f = linkFrames(asm, new Map(Object.entries(at(r, t).joints ?? {})));
        return new Vector3().setFromMatrixPosition(f.get('pad1')!).distanceTo(new Vector3().setFromMatrixPosition(f.get('pad2')!));
      };
      const clashes = (await interference(asm, new Map(Object.entries(at(r, 1.4).joints ?? {})))).filter((c) => c.volumeMm3 >= 1);
      const [open, closed, again] = [gap(0.4), gap(1.4), gap(2.4)];
      return [
        crit('one servo', ofKind(p, 'servo').length === 1, `${ofKind(p, 'servo').length} servo(s)`),
        crit('open at power-up (≥ 30 mm)', open >= 30, `${open.toFixed(1)} mm`),
        crit('closed after a press (≤ 10 mm)', closed <= 10, `${closed.toFixed(1)} mm`),
        crit('nothing overlaps when closed', clashes.length === 0, clashes.map((c) => `${c.a}/${c.b} ${c.volumeMm3.toFixed(0)} mm³`).join(', ') || 'none'),
        crit('open again after the next press (≥ 30 mm)', again >= 30, `${again.toFixed(1)} mm`),
      ];
    },
  },
  {
    id: 'pan-tilt',
    title: 'Pan-tilt head on two pots',
    prompt:
      'A pan-tilt head (Orrery assembly) carrying a camera link with link id "camera" whose local +X axis is the viewing direction (level at home). A pan servo turns it about the vertical axis, a tilt servo on the pan stage tilts it upward. Potentiometer "panpot" sets pan from -90° to +90° (mid-travel = straight ahead), potentiometer "tiltpot" sets tilt from 0° (level, pot at GND) to 60° up (pot at 5 V). Wire each pot with pin 1 to GND and pin 3 to 5 V.',
    seconds: 3,
    mechanics: 'static',
    inputs: (p) => {
      if (!['panpot', 'tiltpot'].every((id) => p.devices.some((d) => d.id === id && d.kind === 'pot'))) return 'needs potentiometers "panpot" and "tiltpot"';
      return [
        { t: 0, pot: 'panpot', value: 0.5 },
        { t: 0, pot: 'tiltpot', value: 0 },
        { t: 1, pot: 'panpot', value: 0 },
        { t: 1, pot: 'tiltpot', value: 1 },
        { t: 2, pot: 'panpot', value: 1 },
        { t: 2, pot: 'tiltpot', value: 0.5 },
      ];
    },
    grade: (p, r) => {
      const asm = p.assembly;
      if (!asm?.links.some((l) => l.id === 'camera')) return [crit('a camera link', false, 'no link "camera"')];
      const look = (t: number) => {
        const f = linkFrames(asm, new Map(Object.entries(at(r, t).joints ?? {}))).get('camera')!;
        const d = new Vector3(1, 0, 0).applyQuaternion(new Quaternion().setFromRotationMatrix(f)).normalize();
        return { az: (Math.atan2(-d.z, d.x) * 180) / Math.PI, el: (Math.asin(d.y) * 180) / Math.PI };
      };
      const [a, b, c] = [look(0.95), look(1.95), look(2.95)];
      const fmt = (x: { az: number; el: number }) => `pan ${x.az.toFixed(1)}°, tilt ${x.el.toFixed(1)}°`;
      return [
        crit('straight ahead and level (±5°)', Math.abs(a.az) <= 5 && Math.abs(a.el) <= 5, fmt(a)),
        crit('panned 90° one way, tilted 60° (±5°)', Math.abs(Math.abs(b.az) - 90) <= 5 && Math.abs(b.el - 60) <= 5, fmt(b)),
        crit('panned 90° the other way, tilted 30° (±5°)', Math.abs(Math.abs(c.az) - 90) <= 5 && Math.sign(c.az) === -Math.sign(b.az) && Math.abs(c.el - 30) <= 5, fmt(c)),
      ];
    },
  },
  {
    id: 'arm-two-joint-reach',
    title: 'Two-joint arm reaches a point',
    prompt:
      'A two-joint arm (Orrery assembly) in a vertical plane: an upper arm 100 mm between the shoulder and elbow axes and a forearm 80 mm from the elbow axis to the tip, each joint turned by its own SG90. Name the shoulder joint "shoulder" and put a small link "tip" at the end of the forearm. At power-up the arm points straight up. A press of a push button moves the tip to 120 mm out and 60 mm up from the shoulder axis; the next press brings it back straight up. Power the servos from a 5 V bench supply.',
    seconds: 2.5,
    mechanics: 'static',
    inputs: (p) => presses(p, [0.5, 1.5]),
    grade: (p, r) => {
      const asm = p.assembly;
      const shoulder = asm?.joints.find((j) => j.id === 'shoulder');
      if (!asm || !shoulder || !asm.links.some((l) => l.id === 'tip')) return [crit('joint "shoulder" and link "tip"', false, 'missing')];
      const where = (t: number) => {
        const f = linkFrames(asm, new Map(Object.entries(at(r, t).joints ?? {})));
        const v = new Vector3().setFromMatrixPosition(f.get('tip')!).sub(new Vector3().setFromMatrixPosition(f.get(shoulder.child)!));
        return { out: Math.hypot(v.x, v.z), up: v.y };
      };
      const fmt = (x: { out: number; up: number }) => `${x.out.toFixed(1)} mm out, ${x.up.toFixed(1)} mm up`;
      const near = (x: { out: number; up: number }, out: number, up: number) => Math.hypot(x.out - out, x.up - up) <= 5;
      const [a, b, c] = [where(0.4), where(1.4), where(2.4)];
      return [
        crit('straight up at power-up (tip 180 mm above the shoulder, ±5 mm)', near(a, 0, 180), fmt(a)),
        crit('tip at 120 mm out, 60 mm up after a press (±5 mm)', near(b, 120, 60), fmt(b)),
        crit('straight up again after the next press (±5 mm)', near(c, 0, 180), fmt(c)),
      ];
    },
  },
];

// ── grading helpers for the tasks above ──

/** Serial output of a board as trimmed, non-empty lines. */
function lines(r: RunReport, board: string | undefined): string[] {
  return (board ? r.serial[board] ?? '' : '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
const within = (got: number[], want: number[], tol: number) => got.length === want.length && got.every((x, i) => Math.abs(x - want[i]) <= tol);

/** Durations (ms) of the runs of a boolean read from the samples, from the first rising edge; the last, unfinished run is dropped. */
function levelRuns(r: RunReport, level: (s: Sample) => boolean): { level: boolean; ms: number }[] {
  const out: { level: boolean; ms: number }[] = [];
  let start: number | null = null;
  let cur = false;
  for (const s of r.samples) {
    const l = level(s);
    if (start === null) {
      if (l) {
        start = s.t;
        cur = true;
      }
      continue;
    }
    if (l !== cur) {
      out.push({ level: cur, ms: Math.round((s.t - start) * 1000) });
      start = s.t;
      cur = l;
    }
  }
  return out;
}

function checkpoints(r: RunReport, device: string, key: string, want: [number, boolean, string][]): Criterion[] {
  return want.map(([t, on, why]) => {
    const got = at(r, t).devices[device]?.[key] === true;
    return crit(`${device} ${on ? 'on' : 'off'} at ${t} s (${why})`, got === on, `${got ? 'on' : 'off'}`);
  });
}

function angleCheckpoints(r: RunReport, servo: string, want: [number, number, number][]): Criterion[] {
  return want.map(([t, deg, tol]) => {
    const a = num(at(r, t).devices[servo]?.angle);
    return crit(`${servo} at ${deg}° at ${t} s (±${tol}°)`, Math.abs(a - deg) <= tol, `${a.toFixed(1)}°`);
  });
}

/** Every servo's V+ on a bench supply's + (not a board's 5 V), and no board rail over its USB fuse. */
function servosOnSupply(p: Project, servos: string[]): Criterion {
  const nets = new Netlist(p);
  const bad = servos.filter((id) => {
    const n = nets.netOf.get(`${id}.V+`);
    return n === undefined || !nets.members[n].some((m) => p.devices.find((d) => d.id === m.split('.')[0])?.kind === 'psu' && m.endsWith('.+'));
  });
  return crit('servos powered from a bench supply', bad.length === 0, bad.length ? `not on a supply: ${bad.join(', ')}` : 'all on a supply');
}

function noStepperTrouble(r: RunReport): Criterion {
  const warns = r.checks.filter((c) => c.level === 'warn' && /lost|µF|reversed|ignores|buzz/.test(c.msg));
  return crit('no lost steps, driver wired as Pololu recommends', warns.length === 0, warns.map((w) => w.msg).join(' | ') || 'none');
}

/** Grade a submitted project: run it with the task's inputs, then the task's checks; a dirty bench fails. */
export async function gradeTask(task: Task, submitted: unknown, firmware: Record<string, string>): Promise<Grade> {
  let project: Project;
  try {
    project = parseProject(typeof submitted === 'string' ? submitted : JSON.stringify(submitted));
  } catch (e) {
    return { pass: false, criteria: [crit('an Orrery project', false, (e as Error).message)] };
  }
  const raw = typeof submitted === 'string' ? JSON.parse(submitted) : submitted;
  const lint = lintProject(raw, project);
  const inputs = task.inputs ? task.inputs(project) : [];
  if (typeof inputs === 'string') return { pass: false, criteria: [crit('the tester can operate it', false, inputs)] };
  const report = await runProject(project, { seconds: task.seconds, firmware, inputs, mechanics: task.mechanics ?? 'off', sampleEvery: task.sampleEvery ?? 0.05, clashChecks: 8 });
  const criteria = [
    crit('clean bench (no ignored wires, error checks, clashes or overloads)', lint.length === 0 && report.ok, [...lint, ...report.problems].join(' | ') || 'clean'),
    ...(await task.grade(project, report)),
  ];
  return { pass: criteria.every((c) => c.pass), criteria, report };
}

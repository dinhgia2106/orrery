// The Orrery design benchmark: tasks described in words, graded by the simulator. Each grader runs the
// submitted bench itself, with inputs the agent does not see, and measures what the firmware, the circuit and
// the mechanism did. Tolerances are stated next to each check.
import { Quaternion, Vector3 } from 'three';
import { runProject, type BenchInput, type RunReport, type Sample } from '../src/headless/run';
import { Netlist } from '../src/lab/circuit';
import { parseProject, type Project } from '../src/lab/project';
import { lintProject } from '../src/mcp/tools';
import type { Assembly, Joint } from '../src/mech/assembly';
import { linkFrames, massProperties } from '../src/mech/physics';

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
];

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

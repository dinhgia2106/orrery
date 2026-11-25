// Runs a lab project start to finish with no browser: real firmware on every board, the wired circuit, the
// mechanism's gravity loads and, optionally, its rigid-body dynamics. Returns one JSON-friendly report — what a
// script, a test or an agent needs to judge a design without looking at the 3D view.
import { jointValues, validateAssembly, type Assembly, type Vec3 } from '../mech/assembly';
import { Dynamics, loadRapier } from '../mech/dynamics';
import { CLASH_MIN_MM3, interference, linkFrames, massProperties, type MassProps } from '../mech/physics';
import { readTendons } from '../mech/tendon';
import { LabSimulation, type Check } from '../lab/labsim';
import type { Project } from '../lab/project';
import { parseIntelHex } from '../sim/hex';
import type { PartState } from '../sim/parts';

/** Firmware for a board: flash words, or Intel HEX text as arduino-cli writes it. */
export type Firmware = Uint16Array | string;

/** Something done to the bench at simulated time `t` (seconds). */
export type BenchInput =
  /** Press a button and release it after `holdMs` (default 100 ms). */
  | { t: number; press: string; holdMs?: number }
  /** Turn a potentiometer's wiper to `value` (0–1). */
  | { t: number; pot: string; value: number }
  /** Type into a board's serial port (the first board when `board` is left out). */
  | { t: number; serial: string; board?: string }
  /** Drop a loose PLA ball or cube centred at `at` (mm, bench frame); needs mechanics "dynamic". */
  | { t: number; drop: 'ball' | 'box'; sizeMm: number; at: Vec3 };

export interface RunOptions {
  /** Simulated time to run, seconds. */
  seconds: number;
  /** Firmware per board id ("uno", "uno2", …); boards without one run a blank chip. */
  firmware?: Record<string, Firmware>;
  inputs?: BenchInput[];
  /** Interval between recorded samples, seconds (default 0.05). */
  sampleEvery?: number;
  /**
   * "static": gravity loads on the actuators and collision checks in sampled poses (default when the project has
   * an assembly). "dynamic": also run the Rapier world, so joints lag, stall and touch. "off": electronics only.
   */
  mechanics?: 'off' | 'static' | 'dynamic';
  /** Poses checked for part-to-part overlap in "static" mode, spread evenly over the run (default 5). */
  clashChecks?: number;
}

export interface ReportedCheck extends Check {
  /** Simulated time the check was first seen, s. */
  firstAt: number;
}

export interface Sample {
  t: number;
  devices: Record<string, PartState>;
  /** Joint angles, degrees from the home pose (when there is a mechanism). */
  joints?: Record<string, number>;
}

export interface ActuatorSummary {
  device: string;
  /** Stall (servo) or holding (stepper) torque, kgf·cm. */
  limitKgfCm: number;
  /** Largest load seen as a share of that limit (above 1: the actuator cannot hold it), and when. */
  peakShare: number;
  peakAt: number;
}

export interface RunReport {
  /** True when there are no error checks, no part clashes and no actuator loaded past its limit. */
  ok: boolean;
  /** One line per reason `ok` is false. */
  problems: string[];
  simulatedSec: number;
  /** Wall-clock time the run took, ms (measured on the machine that ran it). */
  wallMs: number;
  checks: ReportedCheck[];
  serial: Record<string, string>;
  samples: Sample[];
  /** Device states at the end of the run. */
  final: Record<string, PartState>;
  assembly?: { ok: boolean; errors: string[]; warnings: string[] };
  mechanics?: {
    mode: 'static' | 'dynamic';
    totalMassG: number;
    /** Links whose mass is unknown (unsourced material or mesh without massG): loads leave them out. */
    unknownMass: string[];
    actuators: ActuatorSummary[];
    /** Overlapping parts (static mode) with the time of the pose they were found in. */
    clashes: { a: string; b: string; volumeMm3: number; at: number }[];
    /** Per tendon: highest tension and smallest slack seen (negative slack: the geometry asks the line to stretch). */
    tendons: { id: string; device: string; maxTensionN: number; minSlackMm: number }[];
    dynamics?: {
      /** Per driven joint: largest and final gap between the commanded and the reached angle, degrees. */
      tracking: { device: string; maxErrorDeg: number; finalErrorDeg: number }[];
      /** Mechanism part pairs that touched while moving, with the first time. */
      touched: { a: string; b: string; firstAt: number }[];
      /** Loose objects at the end of the run. */
      loose: { id: string; kind: 'ball' | 'box'; sizeMm: number; p: Vec3 }[];
    };
  };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

function toProgram(f: Firmware): Uint16Array {
  return typeof f === 'string' ? parseIntelHex(f) : f;
}

/** Run a project for `opts.seconds` of simulated time and report what happened. */
export async function runProject(project: Project, opts: RunOptions): Promise<RunReport> {
  const wall0 = performance.now();
  const seconds = Math.max(0, opts.seconds);
  const sampleEvery = Math.max(0.001, opts.sampleEvery ?? 0.05);
  const programs = Object.fromEntries(Object.entries(opts.firmware ?? {}).map(([id, f]) => [id, toProgram(f)]));
  const sim = new LabSimulation(project, programs);

  // the mechanism: validated, with masses from its solids
  let asm: Assembly | undefined;
  let asmReport: RunReport['assembly'];
  if (project.assembly) {
    const v = validateAssembly(project.assembly);
    asmReport = { ok: v.ok, errors: v.errors, warnings: v.warnings };
    asm = v.ok ? v.assembly : undefined;
  }
  const mode = asm ? (opts.mechanics ?? 'static') : 'off';
  let props: Map<string, MassProps> | null = null;
  let dyn: Dynamics | null = null;
  if (asm && mode !== 'off') {
    props = await massProperties(asm);
    sim.setMechanics(asm, props);
    if (mode === 'dynamic') dyn = new Dynamics(await loadRapier(), asm, props, jointValues(asm, (d) => sim.deviceAngle(d)));
  }
  const angle = (d: string) => sim.deviceAngle(d);

  const inputs = [...(opts.inputs ?? [])].sort((a, b) => a.t - b.t);
  const releases: { t: number; id: string }[] = [];
  const checks = new Map<string, ReportedCheck>();
  const samples: Sample[] = [];
  const peaks = new Map<string, ActuatorSummary>();
  const tendons = new Map<string, { id: string; device: string; maxTensionN: number; minSlackMm: number }>();
  const tracking = new Map<string, { device: string; maxErrorDeg: number; finalErrorDeg: number }>();
  const touched = new Map<string, { a: string; b: string; firstAt: number }>();
  const problems: string[] = [];

  const noteChecks = (list: Check[], t: number) => {
    for (const c of list) {
      const key = `${c.level}|${c.device ?? ''}|${c.msg}`;
      if (!checks.has(key)) checks.set(key, { ...c, firstAt: r3(t) });
    }
  };
  const apply = (e: BenchInput) => {
    if ('press' in e) {
      const b = sim.buttons.get(e.press);
      if (!b) return void problems.push(`input at ${e.t}s: no button "${e.press}" on the bench`);
      b.press(true);
      releases.push({ t: e.t + (e.holdMs ?? 100) / 1000, id: e.press });
      releases.sort((a, b) => a.t - b.t);
    } else if ('pot' in e) {
      const p = sim.pots.get(e.pot);
      if (!p) return void problems.push(`input at ${e.t}s: no potentiometer "${e.pot}" on the bench`);
      p.set(e.value);
    } else if ('serial' in e) {
      sim.sendSerial(e.serial, e.board);
    } else if ('drop' in e) {
      if (!dyn) return void problems.push(`input at ${e.t}s: dropping a ${e.drop} needs mechanics "dynamic"`);
      dyn.drop(e.drop, e.sizeMm, e.at);
    }
  };

  // mechanics, read every 10 ms of simulated time (the rate labsim refreshes its gravity loads)
  const readMechanics = (t: number) => {
    if (!asm || !props) return;
    const efforts = dyn?.actuatorEfforts();
    for (const l of sim.actuatorLoads()) {
      const share = efforts ? Math.abs(efforts.get(l.device) ?? 0) : l.limitKgfCm > 0 ? Math.abs(l.torqueKgfCm) / l.limitKgfCm : 0;
      const p = peaks.get(l.device);
      if (!p || share > p.peakShare) peaks.set(l.device, { device: l.device, limitKgfCm: l.limitKgfCm, peakShare: r3(share), peakAt: r3(t) });
    }
    if (asm.tendons?.length) {
      const frames = dyn ? dyn.frames() : linkFrames(asm, jointValues(asm, angle));
      for (const r of readTendons(asm, frames, angle, (d) => (efforts ? efforts.get(d) : sim.actuatorEffort(d)))) {
        const cur = tendons.get(r.id) ?? { id: r.id, device: r.device, maxTensionN: 0, minSlackMm: Infinity };
        cur.maxTensionN = Math.max(cur.maxTensionN, r3(r.tensionN));
        cur.minSlackMm = Math.min(cur.minSlackMm, r3(r.slackMm));
        tendons.set(r.id, cur);
      }
    }
    if (dyn) {
      for (const tr of dyn.tracking(angle)) {
        const err = Math.abs(tr.commanded - tr.actual);
        const cur = tracking.get(tr.device) ?? { device: tr.device, maxErrorDeg: 0, finalErrorDeg: 0 };
        cur.maxErrorDeg = Math.max(cur.maxErrorDeg, r3(err));
        cur.finalErrorDeg = r3(err);
        tracking.set(tr.device, cur);
      }
      for (const { a, b } of dyn.touching()) if (!touched.has(`${a}|${b}`)) touched.set(`${a}|${b}`, { a, b, firstAt: r3(t) });
    }
  };

  const takeSample = () => {
    const snap = sim.snapshot();
    noteChecks(snap.checks, snap.time);
    const s: Sample = { t: r3(snap.time), devices: snap.devices };
    if (asm) {
      const values = dyn ? dyn.jointAngles() : jointValues(asm, angle);
      s.joints = Object.fromEntries([...values].map(([k, v]) => [k, r3(v)]));
    }
    samples.push(s);
  };

  noteChecks(sim.fatal, 0);
  takeSample();
  const SLICE = 0.01;
  let nextSample = sampleEvery;
  let i = 0;
  while (sim.time < seconds - 1e-9) {
    const t = sim.time;
    while (i < inputs.length && inputs[i].t <= t + 1e-9) apply(inputs[i++]);
    while (releases.length && releases[0].t <= t + 1e-9) sim.buttons.get(releases.shift()!.id)?.press(false);
    // run up to the next slice boundary, input, release or sample, whichever comes first
    let until = Math.min(seconds, t + SLICE, nextSample);
    if (i < inputs.length) until = Math.min(until, inputs[i].t);
    if (releases.length) until = Math.min(until, releases[0].t);
    const dt = Math.max(until - t, 1e-6);
    sim.step(dt);
    dyn?.step(dt, angle);
    readMechanics(sim.time);
    if (sim.time >= nextSample - 1e-9) {
      takeSample();
      nextSample += sampleEvery;
    }
  }
  if (samples[samples.length - 1].t !== r3(sim.time)) takeSample();

  // collisions in static mode: check a few poses spread over the run
  const clashes: NonNullable<RunReport['mechanics']>['clashes'] = [];
  if (asm && mode === 'static') {
    const n = Math.max(1, Math.min(samples.length, opts.clashChecks ?? 5));
    const picked = new Set(Array.from({ length: n }, (_, k) => Math.round((k * (samples.length - 1)) / Math.max(1, n - 1))));
    const seen = new Set<string>();
    for (const k of picked) {
      const s = samples[k];
      for (const c of await interference(asm, new Map(Object.entries(s.joints ?? {})))) {
        const key = [c.a, c.b].sort().join('|');
        if (c.volumeMm3 < CLASH_MIN_MM3 || seen.has(key)) continue;
        seen.add(key);
        clashes.push({ a: c.a, b: c.b, volumeMm3: r3(c.volumeMm3), at: s.t });
      }
    }
  }

  const reported = [...checks.values()];
  for (const c of reported) if (c.level === 'error') problems.push(c.msg);
  for (const c of clashes) problems.push(`${c.a} and ${c.b} overlap by ${c.volumeMm3} mm³ at t = ${c.at} s`);
  for (const p of peaks.values())
    if (p.peakShare > 1) problems.push(`${p.device} is loaded to ${Math.round(p.peakShare * 100)}% of its ${p.limitKgfCm} kgf·cm limit at t = ${p.peakAt} s`);
  if (asmReport && !asmReport.ok) problems.push(...asmReport.errors.map((e) => `assembly: ${e}`));

  const last = sim.snapshot();
  const report: RunReport = {
    ok: problems.length === 0,
    problems,
    simulatedSec: r3(sim.time),
    wallMs: Math.round(performance.now() - wall0),
    checks: reported,
    serial: last.serial,
    samples,
    final: last.devices,
    assembly: asmReport,
  };
  if (asm && props && mode !== 'off') {
    report.mechanics = {
      mode,
      totalMassG: r3(last.mechanismMassG ?? 0),
      unknownMass: [...props].filter(([, m]) => m.how === 'unknown').map(([id]) => id),
      actuators: [...peaks.values()],
      clashes,
      tendons: [...tendons.values()],
    };
    if (dyn) {
      report.mechanics.dynamics = {
        tracking: [...tracking.values()],
        touched: [...touched.values()],
        loose: dyn.loosePoses().map((l) => ({ id: l.id, kind: l.kind, sizeMm: l.sizeMm, p: l.pose.p.map(r3) as Vec3 })),
      };
      dyn.dispose();
    }
  }
  return report;
}

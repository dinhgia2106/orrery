import { describe, expect, it } from 'vitest';
import handHex from '../../public/examples/robot-hand.hex?raw';
import dexHex from '../../public/examples/dexterous-hand.hex?raw';
import dexWristHex from '../../public/examples/dexterous-hand-wrist.hex?raw';
import dexterousJson from '../../examples/dexterous-hand/dexterous-hand.assembly.json';
import { fabricationPackage } from './fabricate';
import armJson from '../../examples/robot-arm/robot-arm.assembly.json';
import handJson from '../../examples/robot-hand/robot-hand.assembly.json';
import { LabSimulation } from '../lab/labsim';
import { TEMPLATES, cloneProject, parseProject } from '../lab/project';
import { parseIntelHex } from '../sim/hex';
import { aiPrompt, jointValues, jointsAtStop, validateAssembly, type Assembly } from './assembly';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe('Orrery Assembly Format v1', () => {
  it('accepts the shipped arm and hand', () => {
    for (const a of [armJson, handJson]) {
      const r = validateAssembly(a);
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    }
  });

  it('explains what is wrong in plain words', () => {
    const a = clone(handJson) as unknown as Assembly;
    a.joints.push({ id: 'loose', type: 'revolute', parent: 'palm', child: 'ghost', position: [0, 0, 0], axis: [0, 0, 0] });
    a.joints[0].drive = { device: 'servo9' };
    a.links.push({ id: 'floating', shape: { box: [1, 1, 1] } });
    const r = validateAssembly(a);
    expect(r.ok).toBe(false);
    const text = r.errors.join('\n');
    expect(text).toMatch(/child link "ghost" does not exist/);
    expect(text).toMatch(/non-zero "axis"/);
    expect(text).toMatch(/device "servo9" is not in "mounts"/);
    expect(text).toMatch(/exactly one root link/);
  });

  it('rejects loops, self-following drives and bad shapes', () => {
    const a = clone(armJson) as unknown as Assembly;
    a.joints.push({ id: 'back', type: 'fixed', parent: 'tip', child: 'base', position: [0, 0, 0] });
    a.links[0].shape = { box: [70, -6, 70] };
    const r = validateAssembly(a);
    expect(r.errors.join('\n')).toMatch(/form a tree|loop/);
    expect(r.errors.join('\n')).toMatch(/"box" must be/);
    const b = clone(handJson) as unknown as Assembly;
    b.joints.find((j) => j.id === 'index_mcp')!.drive = { follow: 'index_dip' };
    expect(validateAssembly(b).errors.join('\n')).toMatch(/follows itself/);
  });

  it('maps servo angles to joints and couples tendon joints by ratio, clamped to limits', () => {
    const a = handJson as unknown as Assembly;
    const v = jointValues(a, (d) => (d === 'servo2' ? 120 : 90));
    expect(v.get('index_mcp')).toBeCloseTo(60, 6); // 120° of 0–180 → 0–90
    expect(v.get('index_pip')).toBeCloseTo(60, 6); // ratio 1
    expect(v.get('index_dip')).toBeCloseTo(45, 6); // ratio 0.75
    expect(v.get('wrist_rot')).toBeCloseTo(0, 6);
    const full = jointValues(a, () => 180);
    expect(full.get('thumb_mcp')).toBe(70);
    expect(jointsAtStop(a, () => 180)).toEqual([]); // the mapping never asks beyond the limits
  });

  it('builds an AI prompt that carries the schema link and the request', () => {
    const p = aiPrompt('a two-finger gripper', 'https://example.test/schema.json', armJson as unknown as Assembly);
    expect(p).toContain('https://example.test/schema.json');
    expect(p).toContain('a two-finger gripper');
    expect(p).toContain('"format": "orrery.assembly"');
  });

  it('survives a project round-trip and drops an invalid assembly', () => {
    const p = cloneProject(TEMPLATES.find((t) => t.id === 'robot-hand')!.project);
    expect(parseProject(JSON.stringify(p)).assembly?.name).toBe('Five-finger tendon hand');
    expect(parseProject(JSON.stringify({ ...p, assembly: { format: 'nope' } })).assembly).toBeUndefined();
  });
});

describe('robot hand template', () => {
  it('the pot closes every finger through its servo; six servos on the bench supply keep the Uno rail low', () => {
    const p = cloneProject(TEMPLATES.find((t) => t.id === 'robot-hand')!.project);
    const sim = new LabSimulation(p, parseIntelHex(handHex));
    sim.pots.get('pot1')!.set(1);
    sim.step(1);
    const a = p.assembly!;
    const v = jointValues(a, (d) => sim.servos.get(d)?.angle);
    for (const f of ['thumb_mcp', 'index_mcp', 'middle_mcp', 'ring_mcp', 'little_mcp']) expect(v.get(f)).toBeGreaterThan(65);
    expect(v.get('index_dip')).toBeGreaterThan(60);
    const snap = sim.snapshot();
    expect(snap.checks).toEqual([]);
    expect(snap.railMa).toBeLessThan(100); // servo current goes to the bench supply, not the USB fuse
    expect(snap.serial.uno).toContain('hand ready');
  });
});

describe('dexterous hand, 17 DOF on two boards', () => {
  it('validates, and every driven joint has its own servo', () => {
    const r = validateAssembly(dexterousJson);
    expect(r.errors).toEqual([]);
    const a = dexterousJson as unknown as Assembly;
    const driven = a.joints.filter((j) => j.drive && 'device' in j.drive);
    expect(driven).toHaveLength(17);
    expect(new Set(driven.map((j) => (j.drive as { device: string }).device)).size).toBe(17);
  });

  it('U1 makes a fist, tells U2 over serial, and the tendon joints follow', () => {
    const p = cloneProject(TEMPLATES.find((t) => t.id === 'dexterous-hand')!.project);
    const sim = new LabSimulation(p, { uno: parseIntelHex(dexHex), uno2: parseIntelHex(dexWristHex) });
    sim.step(3.5); // pose 0 (open) at 0 s, pose 1 (fist) from 2.5 s, eased over 0.4 s
    const snap = sim.snapshot();
    expect(snap.serial.uno).toContain('1 fist');
    expect(snap.serial.uno2).toContain('pose 1 fist');
    expect(snap.checks).toEqual([]);
    const a = p.assembly!;
    const angle = (d: string) => sim.servos.get(d)?.angle;
    const v = jointValues(a, angle);
    expect(v.get('index_mcp')).toBeCloseTo(90, 0);
    expect(v.get('index_pip')).toBeCloseTo(100, 0);
    expect(v.get('index_dip')).toBeCloseTo(70, 0); // follows the middle joint × 0.7
    expect(v.get('wrist_pitch')).toBeCloseTo(((110 - 90) / 180) * 90, 0); // U2 tilts the wrist for the fist
    expect(jointsAtStop(a, angle)).toEqual([]);
  });

  it('bends the first segments alone: in the "knuckles" pose the knuckles reach 90° while the middle joints stay straight', () => {
    const p = cloneProject(TEMPLATES.find((t) => t.id === 'dexterous-hand')!.project);
    const sim = new LabSimulation(p, { uno: parseIntelHex(dexHex), uno2: parseIntelHex(dexWristHex) });
    sim.step(18.3); // pose 7 starts at 7 × 2.5 s = 17.5 s
    expect(sim.snapshot().serial.uno2).toContain('pose 7 knuckles');
    const v = jointValues(p.assembly!, (d) => sim.servos.get(d)?.angle);
    for (const f of ['index', 'middle', 'ring', 'little']) {
      expect(v.get(`${f}_mcp`)).toBeCloseTo(90, 0);
      expect(v.get(`${f}_pip`)).toBeCloseTo(0, 0);
    }
  }, 60_000);

  it('exports a printable servo bed with 15 SG90 pockets and every phalanx', async () => {
    const p = cloneProject(TEMPLATES.find((t) => t.id === 'dexterous-hand')!.project);
    const z = new TextDecoder('latin1').decode(await fabricationPackage(p));
    expect(z).toContain('parts/forearm.stl');
    expect(z).toContain('drawings/index_dist.svg');
    expect(p.assembly!.links.find((l) => l.id === 'forearm')!.features!.filter((f) => 'pocket' in f)).toHaveLength(15);
  });
});

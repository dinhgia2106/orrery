import { describe, expect, it } from 'vitest';
import servoSweepHex from '../../public/examples/servo-sweep.hex?raw';
import { cloneProject, type Project } from '../lab/project';
import { readShareHash } from '../lab/share';
import { TEMPLATES } from '../lab/templates';
import type { Assembly } from '../mech/assembly';
import { TOOLS, callTool, type CompileFn, type ToolContext } from './tools';

const template = (id: string) => cloneProject(TEMPLATES.find((t) => t.id === id)!.project);

/** A compiler stand-in: sketches containing "BROKEN" fail, everything else builds the servo-sweep firmware. */
function fakeCompiler() {
  const calls: string[] = [];
  const compile: CompileFn = async (code) => {
    calls.push(code);
    return code.includes('BROKEN') ? { ok: false, log: "sketch.ino:1:16: error: 'foo' was not declared in this scope" } : { ok: true, hex: servoSweepHex, log: 'Sketch uses 2000 bytes' };
  };
  return { calls, compile };
}

function ctx(files: Record<string, string> = {}): ToolContext & { calls: string[] } {
  const c = fakeCompiler();
  return {
    calls: c.calls,
    compile: c.compile,
    readFile: async (p) => {
      if (p in files) return files[p];
      throw new Error('ENOENT: no such file');
    },
  };
}

const call = async (name: string, args: Record<string, unknown>, c = ctx()) => {
  const r = await callTool(name, args, c);
  return { ...r, json: () => JSON.parse(r.text) };
};

/** An edited copy of the servo sweep, so it is compiled rather than taken from the prebuilt templates. */
let edits = 0;
function editedSweep(): Project {
  const p = template('servo-sweep');
  p.code = `// edit ${++edits}\n${p.code}`;
  return p;
}

describe('MCP tools', () => {
  it('every tool has a description and an object input schema', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(['orrery_guide', 'orrery_get_template', 'orrery_check', 'orrery_compile', 'orrery_simulate', 'orrery_share']);
    for (const t of TOOLS) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe('object');
    }
  });

  it('guide: every topic answers; devices list real pins and part numbers', async () => {
    for (const topic of ['overview', 'project-format', 'assembly-format', 'templates']) expect((await call('orrery_guide', { topic })).text.length).toBeGreaterThan(100);
    const devices = (await call('orrery_guide', { topic: 'devices' })).json();
    const servo = devices.find((d: { kind: string }) => d.kind === 'servo');
    expect(servo.pins).toEqual(['GND', 'V+', 'SIG']);
    expect(servo.part).toMatch(/SG90/);
    expect(devices.find((d: { kind: string }) => d.kind === 'uno').notModelled).toContain('RESET');
    expect((await call('orrery_guide', { topic: 'nope' })).isError).toBe(true);
  });

  it('get_template returns a project, or the list of ids', async () => {
    expect((await call('orrery_get_template', { id: 'robot-arm' })).json().assembly.links.length).toBeGreaterThan(0);
    const miss = await call('orrery_get_template', { id: 'x' });
    expect(miss.isError).toBe(true);
    expect(miss.text).toMatch(/servo-sweep/);
  });

  it('check: a template is clean and its mechanism is weighed', async () => {
    const r = (await call('orrery_check', { project: template('robot-arm') })).json();
    expect(r.ok).toBe(true);
    expect(r.mechanism.massG).toBeGreaterThan(0);
    expect(r.mechanism.clashesAtHome).toEqual([]);
  });

  it('check: says what the simulator would silently ignore', async () => {
    const p = template('servo-sweep') as Project & { devices: unknown[]; wires: unknown[] };
    const raw = JSON.parse(JSON.stringify(p));
    raw.devices.push({ id: 'motor1', kind: 'dc-motor', x: 0, y: 0, props: {} });
    raw.wires.push({ id: 'a', a: 'servo1.SIGNAL', b: 'uno.D9', color: '#000' });
    raw.wires.push({ id: 'b', a: 'uno.RESET', b: 'uno.GND1', color: '#000' });
    raw.wires.push({ id: 'c', a: 'ghost.1', b: 'uno.D2', color: '#000' });
    raw.sketches = { uno2: 'void setup(){}' };
    const r = (await call('orrery_check', { project: JSON.stringify(raw) })).json();
    expect(r.ok).toBe(false);
    const text = r.ignored.join('\n');
    expect(text).toMatch(/unknown kind "dc-motor"/);
    expect(text).toMatch(/servo1 \(servo\) has no pin "SIGNAL" \(pins: GND V\+ SIG\)/);
    expect(text).toMatch(/uno\.RESET is on the real part but not modelled/);
    expect(text).toMatch(/there is no device "ghost"/);
    expect(text).toMatch(/sketches\.uno2 is ignored/);
  });

  it('check: invalid assemblies, a board not named "uno", shorts and parts overlapping at home', async () => {
    const p = template('servo-sweep');
    p.devices[0].id = 'board';
    p.wires = p.wires.map((w) => ({ ...w, b: w.b.replace('uno.', 'board.') }));
    p.wires.push({ id: 's', a: 'board.5V', b: 'board.GND2', color: '#000' });
    const raw = { ...p, assembly: { format: 'orrery.assembly', version: 1, links: [], joints: [] } };
    const r = (await call('orrery_check', { project: raw })).json();
    expect(r.ignored.join('\n')).toMatch(/No board has the id "uno"/);
    expect(r.ignored.some((x: string) => x.startsWith('assembly: '))).toBe(true);
    expect(r.wiring.map((c: { msg: string }) => c.msg).join('\n')).toMatch(/Short circuit/);

    const bar: Assembly = {
      format: 'orrery.assembly',
      version: 1,
      name: 'bar',
      units: 'mm',
      links: [
        { id: 'base', shape: { box: [40, 10, 40] }, material: 'PLA', make: 'print' },
        { id: 'bar', shape: { box: [100, 10, 10] }, position: [50, 0, 0], material: 'PLA', make: 'print' },
        { id: 'block', shape: { box: [20, 20, 20] }, material: 'PLA', make: 'print' },
      ],
      joints: [
        { id: 'j', type: 'revolute', parent: 'base', child: 'bar', position: [0, 100, 0], axis: [0, 0, 1] },
        { id: 'fix', type: 'fixed', parent: 'base', child: 'block', position: [80, 100, 0] },
      ],
    };
    const clash = (await call('orrery_check', { project: { ...template('blink'), assembly: bar } })).json();
    expect(clash.ok).toBe(false);
    expect(clash.mechanism.clashesAtHome[0]).toMatchObject({ a: 'bar', b: 'block' });
  });

  it('reads projects from a path and explains bad input', async () => {
    const c = ctx({ '/w/bench.orrery.json': JSON.stringify(template('blink')), '/w/junk.json': '{"a":' });
    expect((await call('orrery_check', { path: '/w/bench.orrery.json' }, c)).json().ok).toBe(true);
    expect((await call('orrery_check', { path: '/w/missing.json' }, c)).text).toMatch(/Cannot read/);
    expect((await call('orrery_check', { path: '/w/junk.json' }, c)).text).toMatch(/not valid JSON/);
    expect((await call('orrery_check', { project: { version: 2 } }, c)).text).toMatch(/Not an Orrery project/);
    expect((await call('orrery_check', {}, c)).isError).toBe(true);
  });

  it('compile: unchanged templates use their prebuilt firmware; edited sketches are compiled once, then cached', async () => {
    const c = ctx();
    const pre = (await call('orrery_compile', { project: template('two-boards') }, c)).json();
    expect(pre.boards.uno.from).toBe('prebuilt template');
    expect(pre.boards.uno2.from).toBe('prebuilt template');
    expect(c.calls).toHaveLength(0);
    const p = editedSweep();
    expect((await call('orrery_compile', { project: p }, c)).json().boards.uno.from).toBe('compiled');
    expect((await call('orrery_compile', { project: p }, c)).json().boards.uno.from).toBe('compiled (cached)');
    expect(c.calls).toHaveLength(1);
  });

  it('simulate: runs the firmware and trims the report to what was asked', async () => {
    const r = (await call('orrery_simulate', { project: editedSweep(), seconds: 3, maxSamples: 7, watch: ['servo1'] })).json();
    expect(r.ok).toBe(true);
    expect(r.build.uno.ok).toBe(true);
    expect(r.samples).toHaveLength(7);
    expect(r.samples[0].t).toBe(0);
    expect(r.samples[6].t).toBe(3);
    expect(Object.keys(r.samples[3].devices)).toEqual(['servo1']);
    const angles = r.samples.map((s: { devices: { servo1: { angle: number } } }) => s.devices.servo1.angle);
    expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThan(90); // the horn sweeps (7 samples miss its exact ends)
  });

  it('simulate: transient checks are marked as cleared', async () => {
    const r = (await call('orrery_simulate', { project: template('robot-arm'), seconds: 0.5, mechanics: 'off' })).json();
    const floating = r.checks.filter((c: { msg: string }) => /floats/.test(c.msg));
    expect(floating.length).toBeGreaterThan(0); // pins are inputs until setup() runs
    expect(floating.every((c: { atEnd: boolean }) => !c.atEnd)).toBe(true);
  });

  it('simulate: a sketch that does not compile is reported and nothing runs', async () => {
    const p = editedSweep();
    p.code = 'BROKEN\nvoid setup() { foo(); }\nvoid loop() {}\n';
    const r = await call('orrery_simulate', { project: p, seconds: 1 });
    expect(r.isError).toBe(true);
    expect(r.json().build.uno.log).toMatch(/'foo' was not declared/);
    expect(r.json().samples).toBeUndefined();
  });

  it('simulate: ignored wires make the run not ok', async () => {
    const p = editedSweep();
    p.wires.push({ id: 'x', a: 'servo1.SIGNAL', b: 'uno.D10', color: '#000' });
    const r = (await call('orrery_simulate', { project: p, seconds: 0.2 })).json();
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/no pin "SIGNAL"/);
  });

  it('simulate: rejects bad arguments with a reason', async () => {
    const p = template('servo-sweep');
    expect((await call('orrery_simulate', { project: p, seconds: 0 })).text).toMatch(/"seconds"/);
    expect((await call('orrery_simulate', { project: p, seconds: 61 })).text).toMatch(/at most 60/);
    expect((await call('orrery_simulate', { project: p, seconds: 1, inputs: [{ t: 0 }] })).text).toMatch(/exactly one of/);
    expect((await call('orrery_simulate', { project: p, seconds: 1, inputs: [{ t: 0, pot: 'pot1', value: 2 }] })).text).toMatch(/between 0 and 1/);
    expect((await call('orrery_simulate', { project: p, seconds: 1, mechanics: 'full' })).isError).toBe(true);
  });

  it('share: a link that opens the bench with its compiled firmware', async () => {
    const p = editedSweep();
    const r = (await call('orrery_share', { project: p, base: 'http://localhost:5173/' })).json();
    expect(r.url).toMatch(/^http:\/\/localhost:5173\/#z=/);
    expect(r.firmwareIncluded).toEqual(['uno']);
    const back = await readShareHash(r.url.slice(r.url.indexOf('#')));
    expect(back!.project.code).toBe(p.code);
    expect(back!.firmware.uno).toBe(servoSweepHex);
    expect((await call('orrery_share', { project: p, base: 'javascript:alert(1)' })).isError).toBe(true);
  });
});

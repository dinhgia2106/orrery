import { describe, expect, it } from 'vitest';
import { TEMPLATES } from '../lab/templates';
import { jointValues, validateAssembly, type Assembly, type Tendon, type TendonPoint } from './assembly';
import { linkFrames } from './physics';
import { TendonModel, deviceHome, tensionShare } from './tendon';

const DEG = Math.PI / 180;

/** A base with an SG90 and an arm hinged about Z at (0, 100, 0); the servo's 0–180° turns the arm −90…90°. */
function lever(path: TendonPoint[], spool: number, wind: 1 | -1): Assembly {
  return {
    format: 'orrery.assembly',
    version: 1,
    name: 'lever',
    units: 'mm',
    placement: [0, 0, 0],
    links: [
      { id: 'base', shape: { box: [60, 10, 60] }, position: [0, 5, 0] },
      { id: 'arm', shape: { box: [80, 6, 6] }, position: [40, 0, 0] },
    ],
    joints: [{ id: 'hinge', type: 'revolute', parent: 'base', child: 'arm', position: [0, 100, 0], axis: [0, 0, 1], limits: [-90, 90], drive: { device: 'servo1', from: [0, 180], to: [-90, 90] } }],
    mounts: [{ device: 'servo1', kind: 'servo', link: 'base', position: [20, 10, 20] }],
    tendons: [{ id: 't', device: 'servo1', spool, wind, path }],
  };
}

/** The line in the pose the device angles give. */
function at(asm: Assembly, t: Tendon, angles: Map<string, number>) {
  const home = linkFrames(asm, jointValues(asm, (d) => deviceHome(asm, d)));
  const m = new TendonModel(asm, t, home);
  return m.at(linkFrames(asm, jointValues(asm, (d) => angles.get(d) ?? deviceHome(asm, d))), angles.get(t.device) ?? m.homeAngle);
}

describe('tendons', () => {
  it('a line wrapping a joint takes up exactly radius × angle, and a matching spool keeps it taut', () => {
    // up from a guide below the hinge, tangent to a 10 mm circle round it, over the top to an anchor on the arm
    const path: TendonPoint[] = [
      { link: 'base', at: [10, 50, 0] },
      { wrap: 'hinge', r: 9.99, sense: 1 },
      { link: 'arm', at: [0, 10, 0] },
    ];
    const asm = lever(path, 9.99, -1);
    const t = asm.tendons![0];
    const L0 = at(asm, t, new Map([['servo1', 90]])).length;
    for (const a of [100, 120, 150, 175]) {
      const st = at(asm, t, new Map([['servo1', a]]));
      expect(st.length - L0).toBeCloseTo(9.99 * (a - 90) * DEG, 1);
      expect(Math.abs(st.slack)).toBeLessThan(0.05);
    }
    // wound the other way, the spool would reel in what the joint pays out: the line is asked to stretch
    const wrong = lever(path, 9.99, 1);
    expect(at(wrong, wrong.tendons![0], new Map([['servo1', 150]])).slack).toBeLessThan(-15);
  });

  it('the wrap goes the way it is told, even when the other way round is shorter', () => {
    const path: TendonPoint[] = [{ link: 'base', at: [10, 50, 0] }, { wrap: 'hinge', r: 9.99, sense: 1 }, { link: 'arm', at: [0, 10, 0] }];
    const asm = lever(path, 9.99, -1);
    // at 180° the arm has turned 90°: anticlockwise the line goes ~260° round the hinge, the short way ~100°
    const long = at(asm, asm.tendons![0], new Map([['servo1', 180]])).length;
    const free = lever([path[0], { wrap: 'hinge', r: 9.99 }, path[2]], 9.99, -1);
    expect(long).toBeGreaterThanOrEqual(at(free, free.tendons![0], new Map([['servo1', 180]])).length - 1e-6);
  });

  it('a line in a sheath keeps its length however the sheath ends move', () => {
    const asm = lever([{ link: 'base', at: [0, 20, 25], sheath: true }, { link: 'arm', at: [60, 0, 0] }], 8, 1);
    const t = asm.tendons![0];
    const a = at(asm, t, new Map([['servo1', 90]])).length;
    const b = at(asm, t, new Map([['servo1', 20]])).length;
    expect(b).toBeCloseTo(a, 6);
  });

  it('only the line the actuator reels in carries its torque', () => {
    const t = (wind: 1 | -1): Tendon => ({ id: 'x', device: 's', spool: 5, wind, path: [] });
    expect(tensionShare(t(1), 0.4)).toBeCloseTo(0.4);
    expect(tensionShare(t(-1), 0.4)).toBe(0);
    expect(tensionShare(t(-1), -1.5)).toBe(1);
    expect(tensionShare(t(1), -0.3)).toBe(0);
  });

  it('rejects tendons and axles that cannot exist', () => {
    const asm = lever([{ link: 'base', at: [0, 0, 0], sheath: true }], 0, 2 as 1);
    asm.tendons!.push({ id: 'u', device: 'nothing', spool: 5, wind: 1, path: [{ wrap: 'hinge', r: 5 }, { link: 'ghost', at: [0, 0, 0] }] });
    asm.joints.push({ id: 'glue', type: 'fixed', parent: 'arm', child: 'tip', position: [80, 0, 0], axle: { size: 'M2', length: 10 } });
    asm.links.push({ id: 'tip', shape: { sphere: 3 } });
    const v = validateAssembly(asm);
    const all = v.errors.join('\n');
    expect(all).toContain('"spool" must be a radius');
    expect(all).toContain('"wind" must be 1 or -1');
    expect(all).toContain('a sheath must end at a later point');
    expect(all).toContain('device "nothing" is not in "mounts"');
    expect(all).toContain('a wrap needs a point before and after it');
    expect(all).toContain('link "ghost" does not exist');
    expect(all).toContain('only a revolute joint turns on an "axle"');
  });

  for (const id of ['robot-hand', 'dexterous-hand']) {
    it(`${id}: every line stays within 1.5 mm of taut over its servo's range, and other joints pull it by under 2.5 mm`, () => {
      const v = validateAssembly(TEMPLATES.find((x) => x.id === id)!.project.assembly);
      expect(v.errors).toEqual([]);
      const asm = v.assembly!;
      const devices = (asm.mounts ?? []).map((m) => m.device);
      const range = (dev: string): [number, number] => {
        const j = asm.joints.find((x) => x.drive && 'device' in x.drive && x.drive.device === dev);
        return (j?.drive as { from?: [number, number] }).from ?? [0, 180];
      };
      expect(asm.tendons!.length).toBeGreaterThan(5);
      for (const t of asm.tendons!) {
        let own = 0;
        let coupled = 0;
        for (const dev of devices) {
          const [a0, a1] = range(dev);
          for (let k = 0; k <= 8; k++) {
            const slack = at(asm, t, new Map([[dev, a0 + ((a1 - a0) * k) / 8]])).slack;
            if (dev === t.device) own = Math.max(own, Math.abs(slack));
            else coupled = Math.max(coupled, Math.abs(slack));
          }
        }
        expect(own, t.id).toBeLessThan(1.5);
        expect(coupled, t.id).toBeLessThan(2.5);
      }
    });
  }
});

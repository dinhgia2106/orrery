import { describe, expect, it } from 'vitest';
import { TEMPLATES } from '../lab/project';
import type { Link } from './assembly';
import { DEFAULT_PRINT, planPart, planStl, printPackage } from './print';

/** A 40 × 5 × 40 mm plate on top of a 10 × 30 × 10 mm post (a "T" standing on the post). */
const tee: Link = {
  id: 'tee',
  shape: { box: [40, 5, 40] },
  position: [0, 32.5, 0],
  features: [{ add: { shape: { box: [10, 30, 10] }, position: [0, 15, 0] } }],
  material: 'PLA',
  make: 'print',
};

describe('3D print export', () => {
  it('turns a part so it needs no support when it can, and measures it Z-up on the bed', async () => {
    const p = (await planPart(tee))!;
    // upside down: the plate lies on the bed, the post stands up, nothing overhangs
    expect(p.down).toBe('+y');
    expect(p.overhangMm2).toBeLessThan(1);
    expect(p.supports).toBeNull();
    expect(p.size[0]).toBeCloseTo(40, 1);
    expect(p.size[2]).toBeCloseTo(35, 1);
    expect(p.part.bbox.min[2]).toBeCloseTo(0, 3);
    expect(p.volumeMm3).toBeCloseTo(40 * 5 * 40 + 10 * 30 * 10, -1);
    expect(p.massG!).toBeCloseTo(((40 * 5 * 40 + 10 * 30 * 10) / 1000) * 1.24, 1);
  });

  it('standing on its post, the plate overhangs and gets columns from the bed up to it, short of the part by the gap', async () => {
    const p = (await planPart(tee, { ...DEFAULT_PRINT, down: { tee: '-y' } }))!;
    expect(p.auto).toBe(false);
    expect(p.overhangMm2).toBeCloseTo(40 * 40 - 10 * 10, -1);
    expect(p.supports).not.toBeNull();
    const s = p.supports!;
    expect(s.bbox.min[2]).toBeCloseTo(0, 3);
    expect(s.bbox.max[2]).toBeCloseTo(30 - DEFAULT_PRINT.gap, 2);
    // the columns fill the area under the wings, not under the post
    const columns = s.volumeMm3 / (DEFAULT_PRINT.column ** 2 * (30 - DEFAULT_PRINT.gap));
    const expected = (40 * 40 - 10 * 10) / DEFAULT_PRINT.spacing ** 2;
    expect(columns).toBeGreaterThan(expected * 0.8);
    expect(columns).toBeLessThan(expected * 1.2);
    // one STL with both: 50 bytes a triangle after the 84-byte header
    const stl = planStl(p);
    expect((stl.length - 84) / 50).toBe((p.part.triangles.length + s.triangles.length) / 3);
  });

  it('scales parts, warns that scaled holes no longer fit, and checks the bed', async () => {
    const holed: Link = { ...tee, features: [...tee.features!, { hole: { d: 2.4, position: [15, 32.5, 15] } }] };
    const half = (await planPart(holed, { ...DEFAULT_PRINT, scale: 0.5 }))!;
    expect(half.size[0]).toBeCloseTo(20, 1);
    expect(half.scaledFeatures).toBe(true);
    const small = (await planPart(tee, { ...DEFAULT_PRINT, bed: [30, 30, 30] }))!;
    expect(small.fits).toBe(false);
  });

  it('packs every printed part of the dexterous hand with a size sheet', async () => {
    const asm = TEMPLATES.find((t) => t.id === 'dexterous-hand')!.project.assembly!;
    const links = asm.links.filter((l) => ['index_prox', 'index_mid', 'palm'].includes(l.id));
    const { zip, plans } = await printPackage(asm.name, links, DEFAULT_PRINT);
    const text = new TextDecoder('latin1').decode(zip);
    expect(text).toContain('print/index_prox.stl');
    expect(text).toContain('print.csv');
    expect(plans).toHaveLength(3);
    for (const p of plans) expect(p.fits).toBe(true);
  }, 60_000);
});

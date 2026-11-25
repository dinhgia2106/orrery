import { describe, expect, it } from 'vitest';
import { jointValues, validateAssembly, type Link } from './assembly';
import { addChild, driveWith, newAssembly, removeLink, setFeatures } from './edit';
import { cloneProject } from '../lab/project';
import { TEMPLATES } from '../lab/templates';
import { fabricationPackage, partSvg } from './fabricate';
import { CLEARANCE_HOLE_MM, featureEdges, linkSolid, manifoldModule, pocketFootprint, toMesh, toStl } from './solid';
import { crc32 } from './zip';

describe('printable solids', () => {
  it('a plate with a NEMA 17 face pocket loses exactly the pilot and four M3 clearance holes', async () => {
    const M = await manifoldModule();
    const link: Link = { id: 'plate', shape: { box: [50, 6, 50] }, make: 'print', features: [{ pocket: { for: 'nema17', position: [0, 0, 0], clearance: 0 } }] };
    expect(validateAssembly({ format: 'orrery.assembly', version: 1, name: 't', units: 'mm', links: [link], joints: [] }).errors).toEqual([]);
    const mesh = toMesh(linkSolid(M, link)!);
    const holes = Math.PI * (11 ** 2 + 4 * (CLEARANCE_HOLE_MM.M3 / 2) ** 2) * 6; // φ22 + 4 × φ3.4, 6 mm deep
    // polygonal holes are slightly smaller than true circles, so the plate keeps a little more material
    expect(mesh.volumeMm3).toBeGreaterThan(50 * 6 * 50 - holes);
    expect(mesh.volumeMm3).toBeLessThan(50 * 6 * 50 - holes * 0.99);
    expect(mesh.bbox.min).toEqual([-25, -3, -25]);
    expect(pocketFootprint('nema17').holes!.map((h) => [h.x, h.z])).toContainEqual([15.5, 15.5]); // 31 mm square
  });

  it('holes, cuts and bosses combine into one solid that exports as binary STL', async () => {
    const M = await manifoldModule();
    const link: Link = {
      id: 'bracket',
      shape: { box: [40, 4, 20] },
      position: [0, 2, 0],
      features: [
        { hole: { d: 3.4, position: [-15, 0, 0] } },
        { hole: { d: 3.4, position: [15, 0, 0] } },
        { cut: { box: [10, 10, 4], position: [0, 2, 8] } },
        { add: { shape: { cylinder: { r: 4, h: 6 } }, position: [0, 7, 0] } },
      ],
    };
    const mesh = toMesh(linkSolid(M, link)!);
    expect(mesh.shells).toBe(1);
    expect(mesh.bbox.max[1]).toBeCloseTo(10, 6); // boss top: 7 + 6/2
    const stl = toStl(mesh, 'bracket');
    const tris = new DataView(stl.buffer).getUint32(80, true);
    expect(tris).toBe(mesh.triangles.length / 3);
    expect(stl.length).toBe(84 + 50 * tris);
    expect(featureEdges(mesh).length).toBeGreaterThan(0);
  });

  it('reports detached solid shells when a boss floats clear of the body', async () => {
    const M = await manifoldModule();
    const floating: Link = {
      id: 'float',
      shape: { box: [20, 4, 20] },
      features: [{ add: { shape: { box: [4, 4, 4] }, position: [0, 10, 0] } }],
    };
    const mesh = toMesh(linkSolid(M, floating)!);
    expect(mesh.shells).toBe(2);
  });

  it('every printed primitive part across all templates is a single connected solid', async () => {
    const M = await manifoldModule();
    for (const tpl of TEMPLATES) {
      const asm = tpl.project.assembly;
      if (!asm) continue;
      for (const link of asm.links) {
        if (link.make !== 'print' || 'mesh' in link.shape) continue;
        const mesh = toMesh(linkSolid(M, link)!);
        expect(mesh.shells, `${tpl.id}:${link.id}`).toBe(1);
      }
    }
  }, 60_000);

  it('meshes are exported as they are, and bad features are explained', async () => {
    const M = await manifoldModule();
    expect(linkSolid(M, { id: 'm', shape: { mesh: { url: 'part.stl' } } })).toBeNull();
    const r = validateAssembly({
      format: 'orrery.assembly',
      version: 1,
      name: 't',
      units: 'mm',
      links: [{ id: 'a', shape: { box: [1, 1, 1] }, features: [{ pocket: { for: 'nema23', position: [0, 0, 0] } }, { hole: { d: -1, position: [0, 0, 0] } }] }],
      joints: [],
    });
    expect(r.errors.join('\n')).toMatch(/pocket "for" must be one of sg90, nema17, a4988, b3f/);
    expect(r.errors.join('\n')).toMatch(/hole needs "d"/);
  });
});

describe('drawings and the fabrication package', () => {
  it('draws a part with its overall sizes, features and title block', async () => {
    const link: Link = { id: 'plate', label: 'motor plate', shape: { box: [50, 6, 50] }, make: 'print', material: 'PETG', features: [{ pocket: { for: 'nema17', position: [0, 0, 0] } }, { hole: { d: 3.4, position: [20, 0, 20] } }] };
    const svg = await partSvg(link, { format: 'orrery.assembly', version: 1, name: 'test rig', units: 'mm', links: [link], joints: [] });
    expect(svg).toContain('width="297mm"');
    expect(svg).toContain('motor plate');
    expect(svg).toContain('PETG');
    expect(svg).toMatch(/>50</); // overall dimension
    expect(svg).toContain('NEMA 17 face');
    expect(svg).toContain('M3 clearance (ISO 273 medium)');
  });

  it('packs STL, drawings, BOM and the assembly into a valid ZIP', async () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926); // the standard CRC-32 check value
    const p = cloneProject(TEMPLATES.find((t) => t.id === 'robot-hand')!.project);
    const z = await fabricationPackage(p);
    const text = new TextDecoder('latin1').decode(z);
    const made = p.assembly!.links.filter((l) => l.make === 'print').length;
    expect(text.match(/parts\/[\w-]+\.stl/g)!.length).toBe(made * 3); // local header, central directory, BOM "File" column
    expect(text).toContain('drawings/palm.svg');
    expect(text).toContain('bom.csv');
    expect(text).toContain('A000066');
    const end = new DataView(z.buffer, z.length - 22);
    expect(end.getUint32(0, true)).toBe(0x06054b50);
    expect(end.getUint16(10, true)).toBe(made * 2 + 3); // STLs + SVGs + assembly.json, bom.csv, README.txt
  });
});

describe('3D lab edits keep the assembly valid', () => {
  it('builds a driven arm from nothing, then removes a branch cleanly', () => {
    let a = newAssembly('rig');
    const arm = addChild(a, 'base', 'box');
    a = arm.asm;
    const tip = addChild(a, arm.id, 'sphere');
    a = tip.asm;
    a = driveWith(a, `${arm.id}_joint`, 'servo1', 'servo');
    expect(a.mounts).toEqual([{ device: 'servo1', kind: 'servo', link: 'base', position: [0, 0, 0] }]);
    expect(a.joints.find((j) => j.id === `${arm.id}_joint`)!.type).toBe('revolute');
    a = setFeatures(a, arm.id, [{ hole: { d: CLEARANCE_HOLE_MM.M3, position: [0, 0, 0] } }]);
    expect(validateAssembly(a).errors).toEqual([]);
    const v = jointValuesOf(a, 180);
    expect(v.get(`${arm.id}_joint`)).toBe(90);
    a = removeLink(a, arm.id);
    expect(a.links.map((l) => l.id)).toEqual(['base']);
    expect(a.joints).toEqual([]);
    expect(validateAssembly(a).errors).toEqual([]);
    expect(removeLink(a, 'base')).toBe(a); // the root stays
  });
});

function jointValuesOf(a: Parameters<typeof jointValues>[0], servoAngle: number) {
  return jointValues(a, () => servoAngle);
}

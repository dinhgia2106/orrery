// The fabrication package: everything needed to make the mechanism for real, in one ZIP.
//   parts/<id>.stl       watertight solids in mm (printed, cut or machined links; imported meshes as they are)
//   drawings/<id>.svg    one A4 drawing per made part
//   bom.csv              electronics with part numbers, made parts, hardware
//   assembly.json        the Orrery Assembly, to re-import or hand to an AI
//   README.txt           what is in the package and the notes from the assembly
import { billOfMaterials, bomCsv } from '../lab/bom';
import type { Project } from '../lab/project';
import { shapeSize, type Assembly, type Link } from './assembly';
import { partDrawing } from './drawing';
import { linkSolid, manifoldModule, toMesh, toStl, type SolidMesh } from './solid';
import { zip } from './zip';

export const madeHere = (l: Link) => l.make !== undefined && l.make !== 'buy';

/** Solid mesh of a link (null for imported meshes). */
export async function partMesh(link: Link): Promise<SolidMesh | null> {
  const M = await manifoldModule();
  const s = linkSolid(M, link);
  return s ? toMesh(s) : null;
}

function dataUrlBytes(url: string): Uint8Array {
  const b64 = url.slice(url.indexOf(',') + 1);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function partStl(link: Link): Promise<Uint8Array | null> {
  if ('mesh' in link.shape) return link.shape.mesh.data ? dataUrlBytes(link.shape.mesh.data) : null;
  const mesh = await partMesh(link);
  return mesh ? toStl(mesh, link.id) : null;
}

export async function partSvg(link: Link, assembly: Assembly): Promise<string | null> {
  const mesh = await partMesh(link);
  return mesh ? partDrawing(link, mesh, { assembly: assembly.name }) : null;
}

const q = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;

export async function fabricationPackage(project: Project): Promise<Uint8Array> {
  const asm = project.assembly;
  const files: { name: string; data: Uint8Array | string }[] = [];
  const made = (asm?.links ?? []).filter(madeHere);
  const missing: string[] = [];
  for (const l of made) {
    const stl = await partStl(l);
    if (stl) files.push({ name: `parts/${l.id}.stl`, data: stl });
    else missing.push(l.id);
    if (asm && !('mesh' in l.shape)) {
      const svg = await partSvg(l, asm);
      if (svg) files.push({ name: `drawings/${l.id}.svg`, data: svg });
    }
  }
  let csv = bomCsv(billOfMaterials(project));
  if (asm) {
    csv += '\r\n' + [['Made part', 'Label', 'Make', 'Material', 'Size (mm)', 'File'].map(q).join(',')]
      .concat(made.map((l) => [l.id, l.label ?? '', l.make ?? '', l.material ?? '', 'mesh' in l.shape ? 'STL' : shapeSize(l.shape).map((x) => Math.round(x * 10) / 10).join(' x '), `parts/${l.id}.stl`].map(q).join(',')))
      .join('\r\n');
    if (asm.hardware?.length) csv += '\r\n\r\n' + [['Hardware', 'Qty', 'Note'].map(q).join(',')].concat(asm.hardware.map((h) => [h.item, h.qty, h.note ?? ''].map(q).join(','))).join('\r\n');
    csv += '\r\n';
    files.push({ name: 'assembly.json', data: JSON.stringify(asm, null, 2) });
  }
  files.push({ name: 'bom.csv', data: csv });
  files.push({
    name: 'README.txt',
    data: [
      `${project.name} — fabrication package from Orrery`,
      '',
      asm ? `Mechanism: ${asm.name}` : 'No mechanism on this bench.',
      `Made parts: ${made.length} (STL in parts/, drawings in drawings/, units mm)`,
      ...made.map((l) => `  - ${l.id}: ${l.label ?? ''} (${l.make}, ${l.material ?? 'material not set'})`),
      ...(missing.length ? ['', `No STL for: ${missing.join(', ')} (mesh given by URL — download it from its source)`] : []),
      '',
      'Hardware:',
      ...(asm?.hardware ?? []).map((h) => `  - ${h.qty} × ${h.item}${h.note ? ` — ${h.note}` : ''}`),
      '',
      'Notes:',
      ...(asm?.notes ?? []).map((n) => `  - ${n}`),
      '',
      'Pocket clearances are printing allowances, not datasheet values: print a test piece first.',
      'Electronics with part numbers and links are in bom.csv.',
    ].join('\r\n'),
  });
  return zip(files);
}

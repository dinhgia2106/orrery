// A one-sheet manufacturing drawing for a printed part: three orthographic views (third-angle projection)
// drawn from the solid's real edges, overall dimensions, a feature table and a title block. A4 landscape,
// units mm, as SVG so it prints at true scale.
import type { Feature, Link } from './assembly';
import { CLEARANCE_HOLE_MM, DEFAULT_CLEARANCE_MM, featureEdges, pocketFootprint, type SolidMesh } from './solid';

const W = 297;
const H = 210;
const INK = '#1c4fa0';
const LINE = '#1b222b';
const SCALES = [10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05];

type View = { name: string; u: 0 | 1 | 2; v: 0 | 1 | 2; flipV: boolean };
// third-angle: TOP above FRONT, RIGHT to the right of FRONT. Front looks along −Z (X right, Y up).
const FRONT: View = { name: 'FRONT', u: 0, v: 1, flipV: false };
const TOP: View = { name: 'TOP', u: 0, v: 2, flipV: true };
const RIGHT: View = { name: 'RIGHT', u: 2, v: 1, flipV: false };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const fmt = (x: number) => (Math.abs(x - Math.round(x)) < 0.005 ? String(Math.round(x)) : x.toFixed(2).replace(/0$/, ''));

export interface DrawingInfo {
  assembly: string;
  qty?: number;
}

export function featureRows(features: Feature[] = []): string[] {
  return features.map((f) => {
    if ('hole' in f) return `Ø${fmt(f.hole.d)} ${f.hole.depth ? `× ${fmt(f.hole.depth)} deep` : 'THRU'} along ${(f.hole.axis ?? 'y').toUpperCase()} at (${f.hole.position.map(fmt).join(', ')})${holeNote(f.hole.d)}`;
    if ('cut' in f) return `Cut ${f.cut.box.map(fmt).join(' × ')} at (${f.cut.position.map(fmt).join(', ')})`;
    if ('pocket' in f) return `Pocket for ${pocketFootprint(f.pocket.for).label}, +${fmt(f.pocket.clearance ?? DEFAULT_CLEARANCE_MM)} per side, THRU along Y at (${f.pocket.position.map(fmt).join(', ')})`;
    return `Boss/rib ${Object.keys(f.add.shape)[0]} at (${f.add.position.map(fmt).join(', ')})`;
  });
}

function holeNote(d: number): string {
  const hit = (Object.entries(CLEARANCE_HOLE_MM) as [string, number][]).find(([, v]) => Math.abs(v - d) < 0.01);
  return hit ? ` — ${hit[0].replace('_', '.')} clearance (ISO 273 medium)` : '';
}

export function partDrawing(link: Link, mesh: SolidMesh, info: DrawingInfo): string {
  const { min, max } = mesh.bbox;
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  // layout cells (mm on the sheet)
  const cellW = 118;
  const cellH = 70;
  const fit = (view: View) => Math.min(cellW / Math.max(size[view.u], 1e-6), cellH / Math.max(size[view.v], 1e-6));
  const scale = SCALES.find((s) => s <= Math.min(fit(FRONT), fit(TOP), fit(RIGHT)) * 0.85) ?? SCALES[SCALES.length - 1];
  const edges = featureEdges(mesh);
  const origins: Record<string, [number, number]> = { FRONT: [20, 105], TOP: [20, 20], RIGHT: [150, 105] };

  const viewSvg = (view: View) => {
    const [ox, oy] = origins[view.name];
    const w = size[view.u] * scale;
    const h = size[view.v] * scale;
    const cx = ox + (cellW - w) / 2;
    const cy = oy + (cellH - h) / 2;
    const px = (p: number) => cx + (p - min[view.u]) * scale;
    const py = (p: number) => (view.flipV ? cy + (p - min[view.v]) * scale : cy + h - (p - min[view.v]) * scale);
    let d = '';
    for (let i = 0; i < edges.length; i += 6) {
      d += `M${px(edges[i + view.u]).toFixed(2)} ${py(edges[i + view.v]).toFixed(2)}L${px(edges[i + 3 + view.u]).toFixed(2)} ${py(edges[i + 3 + view.v]).toFixed(2)}`;
    }
    const axes = ['X', 'Y', 'Z'];
    return `
  <g>
    <path d="${d}" stroke="${LINE}" stroke-width="0.25" fill="none" stroke-linecap="round"/>
    ${dimension(cx, cy + h + 6, cx + w, cy + h + 6, size[view.u], 'h')}
    ${dimension(cx - 6, cy, cx - 6, cy + h, size[view.v], 'v')}
    <text x="${ox}" y="${oy + cellH + 13}" class="t">${view.name} (${axes[view.u]} → , ${axes[view.v]} ${view.flipV ? '↓' : '↑'})</text>
  </g>`;
  };

  const rows = featureRows(link.features);
  const vol = mesh.volumeMm3 / 1000;
  const title = esc(link.label ?? link.id);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}" font-family="Consolas, 'JetBrains Mono', monospace">
  <style>.t{font-size:3px;fill:${INK};letter-spacing:.2px}.s{font-size:2.6px;fill:${LINE}}.d{font-size:2.6px;fill:${INK}}</style>
  <rect width="${W}" height="${H}" fill="#fff"/>
  <rect x="8" y="8" width="${W - 16}" height="${H - 16}" fill="none" stroke="${INK}" stroke-width="0.6"/>
  ${viewSvg(TOP)}
  ${viewSvg(FRONT)}
  ${viewSvg(RIGHT)}
  <g>
    <text x="150" y="24" class="t">FEATURES</text>
    ${(rows.length ? rows : ['none']).slice(0, 18).map((r, i) => `<text x="150" y="${30 + i * 3.6}" class="s">${i + 1}. ${esc(r)}</text>`).join('\n    ')}
    <text x="150" y="${30 + Math.min(rows.length, 18) * 3.6 + 4}" class="s">Overall ${size.map(fmt).join(' × ')} mm · volume ${vol.toFixed(2)} cm³</text>
  </g>
  <g transform="translate(${W - 8 - 120},${H - 8 - 30})">
    <rect width="120" height="30" fill="#fff" stroke="${INK}" stroke-width="0.5"/>
    ${[
      ['PART', title],
      ['ID', esc(link.id)],
      ['ASSEMBLY', esc(info.assembly)],
      ['MATERIAL', esc(link.material ?? '—')],
      ['MAKE', `${esc(link.make ?? 'print')} · QTY ${info.qty ?? 1}`],
      ['UNITS / SCALE', `mm · ${scale >= 1 ? `${scale}:1` : `1:${fmt(1 / scale)}`} · third-angle projection`],
    ]
      .map(([k, v], i) => `<text x="3" y="${5 + i * 4.6}" class="t">${k}</text><text x="32" y="${5 + i * 4.6}" class="s">${v}</text>`)
      .join('\n    ')}
  </g>
  <text x="12" y="${H - 11}" class="s">Orrery — generated from the assembly; all edges shown. Pocket clearance is a printing allowance: check it against your printer.</text>
</svg>
`;
}

function dimension(x1: number, y1: number, x2: number, y2: number, value: number, dir: 'h' | 'v'): string {
  const a = 1.2;
  const arrows =
    dir === 'h'
      ? `M${x1} ${y1}l${a} ${-a / 2}v${a}zM${x2} ${y2}l${-a} ${-a / 2}v${a}z`
      : `M${x1} ${y1}l${-a / 2} ${a}h${a}zM${x2} ${y2}l${-a / 2} ${-a}h${a}z`;
  const ext = dir === 'h' ? `M${x1} ${y1 - 5}V${y1 + 1}M${x2} ${y2 - 5}V${y2 + 1}` : `M${x1 + 5} ${y1}H${x1 - 1}M${x2 + 5} ${y2}H${x2 - 1}`;
  const tx = dir === 'h' ? `<text x="${(x1 + x2) / 2}" y="${y1 - 1}" class="d" text-anchor="middle">${fmt(value)}</text>` : `<text x="${x1 - 1.5}" y="${(y1 + y2) / 2}" class="d" text-anchor="middle" transform="rotate(-90 ${x1 - 1.5} ${(y1 + y2) / 2})">${fmt(value)}</text>`;
  return `<path d="M${x1} ${y1}L${x2} ${y2}${ext}" stroke="${INK}" stroke-width="0.18" fill="none"/><path d="${arrows}" fill="${INK}"/>${tx}`;
}

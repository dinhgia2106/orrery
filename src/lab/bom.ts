import { CATALOG, type CatalogItem } from '../sim/catalog';
import { DEVICES } from './devices';
import type { Project } from './project';

export interface BomLine {
  qty: number;
  item: CatalogItem;
  /** Reference designators of the devices using this item. */
  refs: string[];
  /** Part values that differ per device (resistor ohms, capacitor µF, supply volts). */
  values: string[];
}

/** Schematic-style reference designators: U1 for the Uno, U2… drivers, M motors, SW, RV, D, R, C, PS. */
export function designators(project: Project): Record<string, string> {
  const count: Record<string, number> = {};
  const out: Record<string, string> = {};
  for (const d of project.devices) {
    const prefix = DEVICES[d.kind].refPrefix;
    count[prefix] = (count[prefix] ?? 0) + 1;
    out[d.id] = `${prefix}${count[prefix]}`;
  }
  return out;
}

export function billOfMaterials(project: Project): BomLine[] {
  const refs = designators(project);
  const lines = new Map<string, BomLine>();
  for (const d of project.devices) {
    const key = DEVICES[d.kind].catalog;
    const line = lines.get(key) ?? { qty: 0, item: CATALOG[key], refs: [], values: [] };
    line.qty++;
    line.refs.push(refs[d.id]);
    if (d.kind === 'resistor') line.values.push(`${refs[d.id]} ${d.props.ohms ?? 220} Ω`);
    if (d.kind === 'cap') line.values.push(`${refs[d.id]} ${d.props.uf ?? 100} µF`);
    if (d.kind === 'psu') line.values.push(`${refs[d.id]} ${d.props.volts ?? 12} V`);
    lines.set(key, line);
  }
  return [...lines.values()];
}

export function bomCsv(lines: BomLine[]): string {
  const q = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [['Qty', 'Part', 'Manufacturer', 'MPN', 'Refs', 'Values', 'Product page', 'Datasheet']];
  for (const l of lines)
    rows.push([String(l.qty), l.item.name, l.item.manufacturer, l.item.mpn, l.refs.join(' '), l.values.join('; '), l.item.url, l.item.datasheet.url]);
  return rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
}

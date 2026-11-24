// Nets from wires, and a small DC solver (modified nodal analysis) for the circuit on the bench.
import { DEVICES } from './devices';
import type { Project } from './project';

/** Groups every pin ("device.pin") into nets: wires plus conductors inside parts. */
export class Netlist {
  private parent = new Map<string, string>();
  readonly netOf = new Map<string, number>();
  readonly members: string[][] = [];
  private readonly wired = new Set<string>();

  constructor(project: Project) {
    for (const d of project.devices) {
      const def = DEVICES[d.kind];
      for (const p of def.pins) if (!p.dummy) this.add(`${d.id}.${p.name}`);
      for (const group of def.internal ?? []) for (let i = 1; i < group.length; i++) this.union(`${d.id}.${group[0]}`, `${d.id}.${group[i]}`);
    }
    for (const w of project.wires)
      if (this.parent.has(w.a) && this.parent.has(w.b)) {
        this.union(w.a, w.b);
        this.wired.add(w.a);
        this.wired.add(w.b);
      }
    const index = new Map<string, number>();
    for (const pin of this.parent.keys()) {
      const root = this.find(pin);
      if (!index.has(root)) {
        index.set(root, this.members.length);
        this.members.push([]);
      }
      const n = index.get(root)!;
      this.netOf.set(pin, n);
      this.members[n].push(pin);
    }
  }

  get count(): number {
    return this.members.length;
  }

  net(pin: string): number {
    const n = this.netOf.get(pin);
    if (n === undefined) throw new Error(`unknown pin ${pin}`);
    return n;
  }

  /** True when a jumper wire touches this pin's net. */
  connected(pin: string): boolean {
    return this.members[this.net(pin)].some((m) => this.wired.has(m));
  }

  private add(pin: string): void {
    if (!this.parent.has(pin)) this.parent.set(pin, pin);
  }

  private find(pin: string): string {
    let p = pin;
    while (this.parent.get(p) !== p) {
      const up = this.parent.get(this.parent.get(p)!)!;
      this.parent.set(p, up);
      p = up;
    }
    return p;
  }

  private union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export type Element =
  | { kind: 'G'; a: number; b: number; g: number; tag?: string }
  /** Current source pushing `i` amps into net `to` (and out of `from`). */
  | { kind: 'I'; from: number; to: number; i: number; tag?: string }
  /** Ideal voltage source: V(p) − V(n) = v. */
  | { kind: 'V'; p: number; n: number; v: number; tag?: string };

export interface Solution {
  volts: Float64Array;
  /** Current delivered out of each voltage source's + terminal, by element index. */
  sourceAmps: Map<number, number>;
  /** Nets with a conductive path to the ground net (the others are floating). */
  driven: Uint8Array;
}

const GMIN = 1e-12; // keeps floating nets solvable; they are reported via `driven`, not their voltage

/** Solve the DC operating point with `ground` as 0 V. */
export function solve(nets: number, ground: number, elements: Element[]): Solution {
  const nodeIdx = new Int32Array(nets).fill(-1);
  let n = 0;
  for (let i = 0; i < nets; i++) if (i !== ground) nodeIdx[i] = n++;
  const vsrc = elements.map((e, i) => (e.kind === 'V' ? i : -1)).filter((i) => i >= 0);
  const size = n + vsrc.length;
  const A = Array.from({ length: size }, () => new Float64Array(size));
  const z = new Float64Array(size);
  const stampG = (a: number, b: number, g: number) => {
    const ia = nodeIdx[a];
    const ib = nodeIdx[b];
    if (ia >= 0) A[ia][ia] += g;
    if (ib >= 0) A[ib][ib] += g;
    if (ia >= 0 && ib >= 0) {
      A[ia][ib] -= g;
      A[ib][ia] -= g;
    }
  };
  for (let i = 0; i < nets; i++) if (nodeIdx[i] >= 0) A[nodeIdx[i]][nodeIdx[i]] += GMIN;
  elements.forEach((e) => {
    if (e.kind === 'G') stampG(e.a, e.b, e.g);
    else if (e.kind === 'I') {
      if (nodeIdx[e.to] >= 0) z[nodeIdx[e.to]] += e.i;
      if (nodeIdx[e.from] >= 0) z[nodeIdx[e.from]] -= e.i;
    }
  });
  vsrc.forEach((ei, k) => {
    const e = elements[ei] as Extract<Element, { kind: 'V' }>;
    const row = n + k;
    const ip = nodeIdx[e.p];
    const ineg = nodeIdx[e.n];
    if (ip >= 0) {
      A[ip][row] += 1;
      A[row][ip] += 1;
    }
    if (ineg >= 0) {
      A[ineg][row] -= 1;
      A[row][ineg] -= 1;
    }
    z[row] = e.v;
  });
  const x = gauss(A, z);
  const volts = new Float64Array(nets);
  for (let i = 0; i < nets; i++) volts[i] = nodeIdx[i] >= 0 ? x[nodeIdx[i]] : 0;
  const sourceAmps = new Map<number, number>();
  vsrc.forEach((ei, k) => sourceAmps.set(ei, -x[n + k]));

  // connectivity to ground through any element
  const adj: number[][] = Array.from({ length: nets }, () => []);
  for (const e of elements) {
    const [a, b] = e.kind === 'G' ? [e.a, e.b] : e.kind === 'V' ? [e.p, e.n] : [e.from, e.to];
    if (e.kind === 'I') continue; // a current source alone does not define a voltage
    adj[a].push(b);
    adj[b].push(a);
  }
  const driven = new Uint8Array(nets);
  const stack = [ground];
  driven[ground] = 1;
  while (stack.length) {
    const v = stack.pop()!;
    for (const u of adj[v]) if (!driven[u]) {
      driven[u] = 1;
      stack.push(u);
    }
  }
  return { volts, sourceAmps, driven };
}

function gauss(A: Float64Array[], b: Float64Array): Float64Array {
  const n = b.length;
  const M = A.map((row) => Float64Array.from(row));
  const x = Float64Array.from(b);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-18) continue; // singular column (e.g. two ideal sources in parallel): leave 0
    [M[c], M[piv]] = [M[piv], M[c]];
    [x[c], x[piv]] = [x[piv], x[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k < n; k++) M[r][k] -= f * M[c][k];
      x[r] -= f * x[c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = Math.abs(M[r][r]) < 1e-18 ? 0 : s / M[r][r];
  }
  return x;
}

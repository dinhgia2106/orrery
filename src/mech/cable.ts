// A tube along a polyline that can be moved every frame without allocating: tendons, sheaths and wires whose
// ends ride on moving parts. The tube is resampled to a fixed number of rings by arc length; u runs along it in
// whatever unit the caller gives (millimetres from the anchor for a tendon, so marks drawn on it travel with
// the line's material).
import { BufferAttribute, BufferGeometry, Vector3 } from 'three';

export class CableGeometry extends BufferGeometry {
  private readonly pos: BufferAttribute;
  private readonly nrm: BufferAttribute;
  private readonly uvs: BufferAttribute;

  constructor(
    readonly rings = 96,
    readonly sides = 6,
    public radius = 0.4,
  ) {
    super();
    const n = rings * (sides + 1);
    this.pos = new BufferAttribute(new Float32Array(n * 3), 3);
    this.nrm = new BufferAttribute(new Float32Array(n * 3), 3);
    this.uvs = new BufferAttribute(new Float32Array(n * 2), 2);
    this.setAttribute('position', this.pos);
    this.setAttribute('normal', this.nrm);
    this.setAttribute('uv', this.uvs);
    const idx: number[] = [];
    for (let i = 0; i < rings - 1; i++)
      for (let j = 0; j < sides; j++) {
        const a = i * (sides + 1) + j;
        const b = a + sides + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    this.setIndex(idx);
  }

  /** Lay the tube along `points`; `u[i]` is the texture coordinate at points[i] (default: arc length, mm). */
  update(points: Vector3[], u?: number[]): void {
    const { rings, sides } = this;
    if (points.length < 2) return;
    const cum = [0];
    for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + points[i].distanceTo(points[i - 1]));
    const total = cum[cum.length - 1] || 1e-6;
    const P = new Vector3();
    const T = new Vector3();
    const N = new Vector3();
    const B = new Vector3();
    const prevT = new Vector3();
    let k = 0;
    for (let r = 0; r < rings; r++) {
      const s = (total * r) / (rings - 1);
      while (k < points.length - 2 && cum[k + 1] < s) k++;
      const span = cum[k + 1] - cum[k] || 1e-6;
      const f = Math.min(1, Math.max(0, (s - cum[k]) / span));
      P.copy(points[k]).lerp(points[k + 1], f);
      T.copy(points[k + 1]).sub(points[k]).normalize();
      const uu = u ? u[k] + (u[k + 1] - u[k]) * f : s;
      if (r === 0) {
        // any normal to start, then carried along (parallel transport) so the tube does not twist
        N.set(Math.abs(T.x) < 0.9 ? 1 : 0, Math.abs(T.x) < 0.9 ? 0 : 1, 0);
        N.addScaledVector(T, -N.dot(T)).normalize();
      } else {
        const axis = new Vector3().crossVectors(prevT, T);
        const sin = axis.length();
        if (sin > 1e-6) N.applyAxisAngle(axis.divideScalar(sin), Math.atan2(sin, prevT.dot(T)));
        N.addScaledVector(T, -N.dot(T)).normalize();
      }
      prevT.copy(T);
      B.crossVectors(T, N);
      for (let j = 0; j <= sides; j++) {
        const a = (j / sides) * Math.PI * 2;
        const c = Math.cos(a);
        const sn = Math.sin(a);
        const nx = N.x * c + B.x * sn;
        const ny = N.y * c + B.y * sn;
        const nz = N.z * c + B.z * sn;
        const i = r * (sides + 1) + j;
        this.pos.setXYZ(i, P.x + nx * this.radius, P.y + ny * this.radius, P.z + nz * this.radius);
        this.nrm.setXYZ(i, nx, ny, nz);
        this.uvs.setXY(i, uu, j / sides);
      }
    }
    this.pos.needsUpdate = true;
    this.nrm.needsUpdate = true;
    this.uvs.needsUpdate = true;
    this.computeBoundingSphere();
  }
}

/** Points along a cubic Bézier from a to b leaving a along `ta` and arriving at b along `tb` (a bent sheath). */
export function sheathCurve(a: Vector3, b: Vector3, ta: Vector3, tb: Vector3, steps = 16): Vector3[] {
  const d = a.distanceTo(b) * 0.4;
  const c1 = a.clone().addScaledVector(ta.clone().normalize(), d);
  const c2 = b.clone().addScaledVector(tb.clone().normalize(), -d);
  const out: Vector3[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const m = 1 - t;
    out.push(
      a
        .clone()
        .multiplyScalar(m * m * m)
        .addScaledVector(c1, 3 * m * m * t)
        .addScaledVector(c2, 3 * m * t * t)
        .addScaledVector(b, t * t * t),
    );
  }
  return out;
}

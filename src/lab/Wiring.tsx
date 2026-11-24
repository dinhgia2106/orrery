// The wiring bench: drag parts, click a pin then another pin to run a jumper wire, click a wire or part
// to select it (Delete removes it). Pan by dragging the background, zoom with the wheel.
import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { DEVICES, type DeviceDef, type PinDef } from './devices';
import type { LabSnapshot } from './labsim';
import { defaultWireColor, newWireId, type Device, type Project } from './project';

export type Selection = { type: 'device' | 'wire'; id: string } | null;

interface Props {
  project: Project;
  onChange: (p: Project, electrical: boolean) => void;
  selection: Selection;
  onSelect: (s: Selection) => void;
  snapshot: LabSnapshot | null;
  refs: Record<string, string>;
  onPress: (deviceId: string, down: boolean) => void;
}

const OUT = 34; // how far a wire leaves a pin before it bends

function pinPos(d: Device, p: PinDef): [number, number] {
  return [d.x + p.x, d.y + p.y];
}

function dirOf(side: PinDef['side']): [number, number] {
  return side === 'top' ? [0, -1] : side === 'bottom' ? [0, 1] : side === 'left' ? [-1, 0] : [1, 0];
}

function wirePath(a: [number, number], sa: PinDef['side'], b: [number, number], sb: PinDef['side']): string {
  const [ax, ay] = dirOf(sa);
  const [bx, by] = dirOf(sb);
  const len = Math.max(OUT, Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.35);
  return `M${a[0]},${a[1]} C${a[0] + ax * len},${a[1] + ay * len} ${b[0] + bx * len},${b[1] + by * len} ${b[0]},${b[1]}`;
}

function findPin(project: Project, ref: string): { d: Device; p: PinDef } | null {
  const [id, name] = ref.split('.');
  const d = project.devices.find((x) => x.id === id);
  const p = d && DEVICES[d.kind].pins.find((x) => x.name === name);
  return d && p ? { d, p } : null;
}

export default function Wiring({ project, onChange, selection, onSelect, snapshot, refs, onPress }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ x: -60, y: -230, w: 1100, h: 760 });
  const [pending, setPending] = useState<{ from: string; x: number; y: number } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<{ kind: 'device' | 'pan'; id?: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);

  const toWorld = useCallback((cx: number, cy: number): [number, number] => {
    const el = svg.current!;
    const pt = el.createSVGPoint();
    pt.x = cx;
    pt.y = cy;
    const m = el.getScreenCTM()!.inverse();
    const r = pt.matrixTransform(m);
    return [r.x, r.y];
  }, []);

  // keep the aspect ratio of the element
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const { width, height } = el.getBoundingClientRect();
      if (width && height) setView((v) => ({ ...v, h: (v.w * height) / width }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // wheel zoom around the cursor (non-passive so the page does not scroll)
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      const k = Math.exp(e.deltaY * 0.0012);
      setView((v) => {
        const w = Math.min(4000, Math.max(250, v.w * k));
        const f = w / v.w;
        return { x: wx - (wx - v.x) * f, y: wy - (wy - v.y) * f, w, h: v.h * f };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [toWorld]);

  // Delete / Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') setPending(null);
      if (e.key === 'Delete' && selection) {
        if (selection.type === 'wire') onChange({ ...project, wires: project.wires.filter((w) => w.id !== selection.id) }, true);
        else
          onChange(
            {
              ...project,
              devices: project.devices.filter((d) => d.id !== selection.id),
              wires: project.wires.filter((w) => !w.a.startsWith(`${selection.id}.`) && !w.b.startsWith(`${selection.id}.`)),
            },
            true,
          );
        onSelect(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, project, onChange, onSelect]);

  const onPinDown = (e: RPointerEvent, ref: string) => {
    e.stopPropagation();
    if (!pending) {
      const [x, y] = toWorld(e.clientX, e.clientY);
      setPending({ from: ref, x, y });
      return;
    }
    if (pending.from !== ref) {
      const exists = project.wires.some((w) => (w.a === pending.from && w.b === ref) || (w.b === pending.from && w.a === ref));
      if (!exists) {
        const wire = { id: newWireId(), a: pending.from, b: ref, color: defaultWireColor(pending.from, ref, project.wires.length) };
        onChange({ ...project, wires: [...project.wires, wire] }, true);
        onSelect({ type: 'wire', id: wire.id });
      }
    }
    setPending(null);
  };

  const onDeviceDown = (e: RPointerEvent, d: Device) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { kind: 'device', id: d.id, sx: e.clientX, sy: e.clientY, ox: d.x, oy: d.y, moved: false };
    onSelect({ type: 'device', id: d.id });
    if (d.kind === 'button') onPress(d.id, true);
  };

  const onBgDown = (e: RPointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false };
  };

  const onMove = (e: RPointerEvent) => {
    if (pending) {
      const [x, y] = toWorld(e.clientX, e.clientY);
      setPending({ ...pending, x, y });
    }
    const g = drag.current;
    if (!g) return;
    const scale = view.w / (svg.current?.getBoundingClientRect().width || 1);
    const dx = (e.clientX - g.sx) * scale;
    const dy = (e.clientY - g.sy) * scale;
    if (Math.abs(dx) + Math.abs(dy) > 2) g.moved = true;
    if (g.kind === 'pan') setView((v) => ({ ...v, x: g.ox - dx, y: g.oy - dy }));
    else if (g.moved) {
      const snap = (n: number) => Math.round(n / 5) * 5;
      onChange({ ...project, devices: project.devices.map((d) => (d.id === g.id ? { ...d, x: snap(g.ox + dx), y: snap(g.oy + dy) } : d)) }, false);
    }
  };

  const onUp = () => {
    const g = drag.current;
    drag.current = null;
    if (g?.kind === 'device') {
      const d = project.devices.find((x) => x.id === g.id);
      if (d?.kind === 'button') onPress(d.id, false);
    }
    if (g?.kind === 'pan' && !g.moved) {
      onSelect(null);
      setPending(null);
    }
  };

  const hoverInfo = (() => {
    if (!hover) return null;
    const hit = findPin(project, hover);
    if (!hit) return null;
    const [x, y] = pinPos(hit.d, hit.p);
    let text = `${refs[hit.d.id] ?? hit.d.id} · ${hit.p.label ?? hit.p.name}`;
    if (hit.d.kind === 'uno') {
      const st = snapshot?.pins[`${hit.d.id}.${hit.p.name}`];
      if (st) text += ` · ${st.mode}${st.volts === null ? ' · floating' : ` · ${st.volts.toFixed(2)} V`}`;
    }
    return { x, y, text };
  })();

  const pendingFrom = pending ? findPin(project, pending.from) : null;

  return (
    <svg
      ref={svg}
      className="wiring"
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      onPointerDown={onBgDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
    >
      <defs>
        <pattern id="minor" width="10" height="10" patternUnits="userSpaceOnUse">
          <path d="M10 0H0V10" fill="none" stroke="rgba(28,79,160,0.08)" strokeWidth="0.6" />
        </pattern>
        <pattern id="major" width="50" height="50" patternUnits="userSpaceOnUse">
          <rect width="50" height="50" fill="url(#minor)" />
          <path d="M50 0H0V50" fill="none" stroke="rgba(28,79,160,0.16)" strokeWidth="0.8" />
        </pattern>
        <radialGradient id="glow">
          <stop offset="0" stopColor="#fff" stopOpacity="0.9" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x={view.x - 5000} y={view.y - 5000} width={view.w + 10000} height={view.h + 10000} fill="url(#major)" />

      {project.devices.map((d) => (
        <g key={d.id} transform={`translate(${d.x},${d.y})`} className={`dev ${selection?.type === 'device' && selection.id === d.id ? 'sel' : ''}`}>
          <g onPointerDown={(e) => onDeviceDown(e, d)} style={{ cursor: 'move' }}>
            <Symbol d={d} def={DEVICES[d.kind]} snapshot={snapshot} />
          </g>
          <text className="ref-label" x={0} y={-8}>
            {refs[d.id] ?? d.id}
            <tspan className="ref-sub"> {DEVICES[d.kind].subtitle}</tspan>
          </text>
        </g>
      ))}

      {project.wires.map((w) => {
        const a = findPin(project, w.a);
        const b = findPin(project, w.b);
        if (!a || !b) return null;
        const path = wirePath(pinPos(a.d, a.p), a.p.side, pinPos(b.d, b.p), b.p.side);
        const sel = selection?.type === 'wire' && selection.id === w.id;
        return (
          <g
            key={w.id}
            className="wire"
            onPointerDown={(e) => {
              e.stopPropagation();
              onSelect({ type: 'wire', id: w.id });
            }}
          >
            <path d={path} stroke="transparent" strokeWidth={12} fill="none" />
            <path d={path} stroke={sel ? '#1c4fa0' : 'rgba(0,0,0,0.35)'} strokeWidth={sel ? 7 : 5} fill="none" strokeLinecap="round" />
            <path d={path} stroke={w.color} strokeWidth={3.2} fill="none" strokeLinecap="round" />
          </g>
        );
      })}

      {pending && pendingFrom && (
        <path
          d={wirePath(pinPos(pendingFrom.d, pendingFrom.p), pendingFrom.p.side, [pending.x, pending.y], 'bottom')}
          stroke="#1c4fa0"
          strokeDasharray="6 4"
          strokeWidth={2}
          fill="none"
          pointerEvents="none"
        />
      )}

      {project.devices.map((d) =>
        DEVICES[d.kind].pins.map((p) => {
          const ref = `${d.id}.${p.name}`;
          const [x, y] = pinPos(d, p);
          return (
            <g key={ref} className={`pin ${p.dummy ? 'dummy' : ''} ${pending?.from === ref ? 'armed' : ''}`}>
              <rect x={x - 3.4} y={y - 3.4} width={6.8} height={6.8} rx={1} />
              {!p.dummy && (
                <circle
                  cx={x}
                  cy={y}
                  r={7}
                  className="pin-hit"
                  onPointerDown={(e) => onPinDown(e, ref)}
                  onPointerEnter={() => setHover(ref)}
                  onPointerLeave={() => setHover((h) => (h === ref ? null : h))}
                />
              )}
              <PinLabel d={d} p={p} x={x} y={y} />
            </g>
          );
        }),
      )}

      {hoverInfo && (
        <g pointerEvents="none" transform={`translate(${hoverInfo.x + 10},${hoverInfo.y - 22})`}>
          <rect className="tip" width={hoverInfo.text.length * 6.1 + 12} height={18} rx={2} />
          <text className="tip-text" x={6} y={12.5}>
            {hoverInfo.text}
          </text>
        </g>
      )}
    </svg>
  );
}

function PinLabel({ d, p, x, y }: { d: Device; p: PinDef; x: number; y: number }) {
  const label = p.label ?? p.name;
  if (d.kind === 'uno') {
    const up = p.side === 'top';
    return (
      <text className="pin-label uno" transform={`translate(${x + 2.5},${up ? y + 9 : y - 9}) rotate(-90)`} textAnchor={up ? 'end' : 'start'}>
        {label}
      </text>
    );
  }
  const anchor = p.side === 'left' ? 'start' : p.side === 'right' ? 'end' : 'middle';
  const dx = p.side === 'left' ? 7 : p.side === 'right' ? -7 : 0;
  const dy = p.side === 'bottom' ? -8 : p.side === 'top' ? 13 : 3;
  return (
    <text className="pin-label" x={x + dx} y={y + dy} textAnchor={anchor}>
      {label}
    </text>
  );
}

// ───────── part drawings ─────────

const E12 = [10, 12, 15, 18, 22, 27, 33, 39, 47, 56, 68, 82];
const BAND = ['#111', '#7b4a2a', '#d32f2f', '#f57c00', '#fbc02d', '#2e7d32', '#1565c0', '#6a1b9a', '#757575', '#fafafa'];

/** 4-band colour code for a resistor value (two significant digits, multiplier, gold 5 %). */
export function resistorBands(ohms: number): string[] {
  if (!(ohms > 0)) return [BAND[0], BAND[0], BAND[0], '#c9a227'];
  const exp = Math.floor(Math.log10(ohms)) - 1;
  const sig = Math.round(ohms / 10 ** exp);
  const digits = sig >= 100 ? [9, 9] : [Math.floor(sig / 10), sig % 10];
  const mult = Math.max(0, Math.min(9, exp));
  return [BAND[digits[0]], BAND[digits[1]], BAND[mult], '#c9a227'];
}
export const RESISTOR_PRESETS = E12.flatMap((v) => [v * 10, v * 100, v * 1000]).sort((a, b) => a - b);

/** Black header strips behind runs of pins 0.1" apart. */
function headerStrips(def: DeviceDef): { x: number; y: number; w: number }[] {
  const out: { x: number; y: number; w: number }[] = [];
  for (const side of ['top', 'bottom'] as const) {
    const xs = def.pins.filter((p) => p.side === side).map((p) => p.x).sort((a, b) => a - b);
    const y = def.pins.find((p) => p.side === side)!.y - 6;
    let start = xs[0];
    for (let i = 1; i <= xs.length; i++) {
      if (i === xs.length || xs[i] - xs[i - 1] > 13) {
        out.push({ x: start - 6.35, y, w: xs[i - 1] - start + 12.7 });
        start = xs[i];
      }
    }
  }
  return out;
}

function Symbol({ d, def, snapshot }: { d: Device; def: DeviceDef; snapshot: LabSnapshot | null }): ReactNode {
  const st = snapshot?.devices[d.id];
  switch (d.kind) {
    case 'uno': {
      const L = snapshot?.pins[`${d.id}.D13`]?.mode === 'HIGH';
      return (
        <g>
          <rect width={def.w} height={def.h} rx={8} className="pcb uno" />
          {/* USB-B (centre 38.1 mm from the analog edge) and barrel jack — approx, as in the 3D model */}
          <rect x={-28} y={(53.4 - 38.1) * 5 - 30} width={80} height={60} className="metal" />
          <rect x={-10} y={(53.4 - 7.6) * 5 - 22} width={70} height={45} className="jack" />
          <rect x={150} y={150} width={180} height={40} rx={3} className="chip" />
          <text x={240} y={175} className="chip-text" textAnchor="middle">
            ATMEGA328P-PU
          </text>
          {headerStrips(def).map((h, i) => (
            <rect key={i} x={h.x} y={h.y} width={h.w} height={12} rx={1.5} className="header" />
          ))}
          <text x={70} y={130} className="board-title">
            UNO
          </text>
          <text x={72} y={146} className="board-sub">
            ARDUINO · R3
          </text>
          <rect x={98} y={52} width={10} height={6} rx={1} fill={L ? '#ffd24a' : '#8a7a3a'} />
          {L && <circle cx={103} cy={55} r={12} fill="url(#glow)" />}
          <text x={112} y={58} className="silk">
            L
          </text>
          <rect x={300} y={110} width={10} height={6} rx={1} fill="#4be37a" />
          <text x={314} y={116} className="silk">
            ON
          </text>
        </g>
      );
    }
    case 'servo': {
      const angle = Number(st?.angle ?? 90);
      return (
        <g>
          <path d={`M0 22 H-0 M0 34.7 H0`} />
          <rect x={30} y={8} width={110} height={54} rx={4} className="servo-body" />
          <rect x={20} y={28} width={130} height={10} rx={2} className="servo-body tab" />
          <circle cx={112} cy={35} r={14} className="servo-gear" />
          <g transform={`translate(112,35) rotate(${angle - 90})`}>
            <rect x={-4} y={-30} width={8} height={34} rx={4} className="horn" />
            <circle r={6} className="horn" />
          </g>
          {['#5a3a22', '#e53935', '#f28c1a'].map((c, i) => (
            <path key={c} d={`M0 ${22 + i * 12.7} C 14 ${22 + i * 12.7}, 16 ${30 + i * 2}, 30 ${30 + i * 2}`} stroke={c} strokeWidth={2.5} fill="none" />
          ))}
          <text x={60} y={58} className="part-text">
            SG90 · {angle.toFixed(0)}°
          </text>
        </g>
      );
    }
    case 'a4988':
      return (
        <g>
          <rect width={def.w} height={def.h} rx={3} className="pcb green" />
          <rect x={45} y={40} width={30} height={30} className="chip" />
          <circle cx={60} cy={95} r={8} className="trimmer" />
          <text x={60} y={def.h - 8} className="part-text light" textAnchor="middle">
            A4988 · ×{String(st?.microsteps ?? 1)}
          </text>
          {st && (
            <circle cx={def.w - 12} cy={def.h - 12} r={4} fill={st.enabled ? '#4be37a' : '#c2412d'}>
              <title>{st.enabled ? 'outputs enabled' : 'not driving the motor'}</title>
            </circle>
          )}
        </g>
      );
    case 'stepper': {
      const angle = Number(st?.angle ?? 0);
      return (
        <g>
          <rect x={14} y={0} width={def.w - 14} height={def.h} rx={10} className="motor" />
          <circle cx={14 + (def.w - 14) / 2} cy={def.h / 2} r={34} className="motor-boss" />
          <g transform={`translate(${14 + (def.w - 14) / 2},${def.h / 2}) rotate(${-angle})`}>
            <circle r={7} className="shaft" />
            <rect x={0} y={-3} width={44} height={6} rx={3} className="flag" />
          </g>
          <text x={14 + (def.w - 14) / 2} y={def.h - 10} className="part-text light" textAnchor="middle">
            NEMA 17 · {angle.toFixed(1)}°
          </text>
          {[0, 1, 2, 3].map((i) => (
            <path key={i} d={`M0 ${34 + i * 12.7} H14`} stroke={['#33c46b', '#1f1f1f', '#e53935', '#3d7bff'][i]} strokeWidth={2.5} />
          ))}
        </g>
      );
    }
    case 'button': {
      const pressed = !!st?.pressed;
      return (
        <g>
          <rect x={4} y={4} width={42} height={42} rx={3} className="switch-body" />
          <path d="M0 8 H50 M0 42 H50" className="internal" />
          <circle cx={25} cy={25} r={pressed ? 10 : 12} className={`plunger ${pressed ? 'down' : ''}`} />
        </g>
      );
    }
    case 'pot': {
      const pos = Number(st?.position ?? 0.5);
      const a = (pos - 0.5) * 280;
      return (
        <g>
          <rect x={4} y={10} width={62} height={42} rx={4} className="pot-body" />
          <g transform={`translate(35,30) rotate(${a})`}>
            <circle r={15} className="knob" />
            <rect x={-1.5} y={-15} width={3} height={10} className="knob-mark" />
          </g>
          <path d="M10 52 V60 M35 52 V60 M60 52 V60" className="leg" />
        </g>
      );
    }
    case 'led': {
      const color = d.props.color ?? '#ff3b30';
      const lvl = Math.min(1, Number(st?.mA ?? 0) / 10);
      return (
        <g>
          {lvl > 0.02 && <circle cx={18} cy={16} r={30} fill={color} opacity={0.35 * lvl} />}
          <path d="M6 30 V14 A12 12 0 0 1 30 14 V30 Z" fill={color} opacity={0.55 + 0.45 * lvl} className="led-lens" />
          <rect x={3} y={30} width={30} height={4} fill={color} opacity={0.7} />
          <path d="M10 34 V56 M26 34 V50" className="leg" />
        </g>
      );
    }
    case 'resistor': {
      const bands = resistorBands(d.props.ohms ?? 220);
      return (
        <g>
          <path d="M0 11 H14 M66 11 H80" className="leg" />
          <rect x={14} y={3} width={52} height={16} rx={7} className="resistor-body" />
          {bands.map((c, i) => (
            <rect key={i} x={22 + i * 9 + (i === 3 ? 6 : 0)} y={3} width={4.5} height={16} fill={c} />
          ))}
          <text x={40} y={34} className="part-text" textAnchor="middle">
            {formatOhms(d.props.ohms ?? 220)}
          </text>
        </g>
      );
    }
    case 'cap':
      return (
        <g>
          <rect x={4} y={0} width={28} height={40} rx={4} className="cap-body" />
          <rect x={24} y={0} width={8} height={40} rx={2} className="cap-stripe" />
          <text x={14} y={24} className="part-text light" textAnchor="middle">
            {d.props.uf ?? 100}µ
          </text>
          <path d="M10 40 V56 M26 40 V52" className="leg" />
        </g>
      );
    case 'psu':
      return (
        <g>
          <rect width={def.w} height={def.h - 12} rx={4} className="psu-body" />
          <rect x={10} y={10} width={70} height={30} rx={2} className="psu-display" />
          <text x={74} y={32} className="psu-digits" textAnchor="end">
            {(d.props.volts ?? 12).toFixed(1)}V
          </text>
          <circle cx={40} cy={def.h - 18} r={7} fill="#e53935" />
          <circle cx={90} cy={def.h - 18} r={7} fill="#222" />
          <path d={`M40 ${def.h - 12} V${def.h} M90 ${def.h - 12} V${def.h}`} className="leg" />
        </g>
      );
  }
}

export function formatOhms(ohms: number): string {
  if (ohms >= 1e6) return `${+(ohms / 1e6).toFixed(2)} MΩ`;
  if (ohms >= 1e3) return `${+(ohms / 1e3).toFixed(2)} kΩ`;
  return `${+ohms.toFixed(2)} Ω`;
}

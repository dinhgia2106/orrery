// 3D bench. Everything is modelled in millimetres from the datasheet figures in sim/catalog.ts; where a
// drawing was not readable the position is marked "approx". Only the parts in the current project are drawn,
// and each model reads its simulated part by id.
import { Grid, OrbitControls, RoundedBox } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { useMemo, useRef, type MutableRefObject, type ReactNode } from 'react';
import { CatmullRomCurve3, Vector3, type Group, type Mesh, type MeshStandardMaterial } from 'three';
import { SPEC } from './sim/catalog';
import type { PartSpec, Simulation } from './sim/engine';
import { Button, Led, Potentiometer, Servo, StepperA4988 } from './sim/parts';

type SimRef = MutableRefObject<Simulation | null>;
type V3 = [number, number, number];

const DEG = Math.PI / 180;
const PRINTED = '#c9d3e2'; // custom 3D-printed parts (not in the BOM)

// ───────────────────────── Arduino UNO R3 ─────────────────────────

const UNO = SPEC.uno;
const UNO_POS: V3 = [-75, 2, 0]; // lifted 2 mm: through-hole leads under the board (approx)
const PCB_TOP = UNO.pcbThicknessMm;
const HEADER_TOP = PCB_TOP + UNO.headerHeightMm;

/**
 * Header pin positions in board coordinates (x along the 68.6 mm length, z across, −z = digital side).
 * approx: from the 0.1" pitch, the 0.16" gap between D7 and D8, and D0/A5 ~5 mm from the right edge.
 */
function headerLocal(pin: string): V3 {
  const pitch = 2.54;
  const right = UNO.lengthMm / 2 - 5.1;
  const zDigital = -UNO.widthMm / 2 + 2.5;
  const zAnalog = UNO.widthMm / 2 - 2.5;
  const d = /^D(\d+)$/.exec(pin);
  if (d) {
    const n = Number(d[1]);
    const x = n <= 7 ? right - n * pitch : right - 7 * pitch - 4.064 - (n - 8) * pitch;
    return [x, HEADER_TOP, zDigital];
  }
  const a = /^A(\d)$/.exec(pin);
  if (a) return [right - (5 - Number(a[1])) * pitch, HEADER_TOP, zAnalog];
  const a0 = right - 5 * pitch;
  const power: Record<string, number> = { VIN: a0 - 2 * pitch, GND: a0 - 3 * pitch, '5V': a0 - 5 * pitch };
  return [power[pin] ?? a0, HEADER_TOP, zAnalog];
}

function pinWorld(pin: string): V3 {
  const [x, y, z] = headerLocal(pin);
  return [UNO_POS[0] + x, UNO_POS[1] + y, UNO_POS[2] + z];
}

function FemaleHeader({ pins, at }: { pins: number; at: V3 }) {
  const len = pins * 2.54;
  return (
    <group position={at}>
      <mesh position={[0, UNO.headerHeightMm / 2, 0]} castShadow>
        <boxGeometry args={[len, UNO.headerHeightMm, 2.54]} />
        <meshStandardMaterial color="#111" roughness={0.7} />
      </mesh>
      {Array.from({ length: pins }, (_, i) => (
        <mesh key={i} position={[-len / 2 + 1.27 + i * 2.54, UNO.headerHeightMm + 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial color="#000" />
        </mesh>
      ))}
    </group>
  );
}

function Uno({ sim, builtinLedId }: { sim: SimRef; builtinLedId?: string }) {
  const led = useRef<Mesh>(null);
  useFrame(() => {
    const mat = led.current?.material as MeshStandardMaterial | undefined;
    if (!mat) return;
    const l = builtinLedId ? sim.current?.part<Led>(builtinLedId) : undefined;
    const st = l?.state();
    mat.emissiveIntensity = st ? 0.05 + Math.max(st.on ? 1 : 0, Number(st.brightness)) * 4 : 0.05;
  });
  const { lengthMm: L, widthMm: W } = UNO;
  const right = L / 2 - 5.1;
  const pitch = 2.54;
  // header centres from headerLocal: D0–D7 (8), D8–SCL (10), power (8), A0–A5 (6)
  const d7 = right - 7 * pitch;
  const d8 = d7 - 4.064;
  const a0 = right - 5 * pitch;
  return (
    <group position={UNO_POS}>
      <RoundedBox args={[L, PCB_TOP, W]} radius={0.6} position={[0, PCB_TOP / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#00878f" roughness={0.55} />
      </RoundedBox>
      {/* USB-B (X2) and 2.1 × 5.5 mm barrel jack (X1) on the left edge — positions approx */}
      <mesh position={[-L / 2 + 6, PCB_TOP + 5.5, W / 2 - 38.1]} castShadow>
        <boxGeometry args={[16, 11, 12]} />
        <meshStandardMaterial color="#c7ccd1" metalness={0.85} roughness={0.25} />
      </mesh>
      <mesh position={[-L / 2 + 5, PCB_TOP + 5.5, W / 2 - 7.6]} castShadow>
        <boxGeometry args={[14, 11, 9]} />
        <meshStandardMaterial color="#0d0d0d" roughness={0.5} />
      </mesh>
      {/* ATMEGA328P-PU in a DIP-28 socket (schematic J-ZU4) — position approx */}
      <mesh position={[12, PCB_TOP + 2, 12]} castShadow>
        <boxGeometry args={[36, 4, 9]} />
        <meshStandardMaterial color="#1a1a1a" roughness={0.6} />
      </mesh>
      <mesh position={[12, PCB_TOP + 5.5, 12]} castShadow>
        <boxGeometry args={[35, 3, 7.4]} />
        <meshStandardMaterial color="#222" roughness={0.35} />
      </mesh>
      {/* 16 MHz resonator, regulator, reset switch — approx */}
      <mesh position={[-14, PCB_TOP + 1, 6]} castShadow>
        <boxGeometry args={[6.5, 2, 3.5]} />
        <meshStandardMaterial color="#bfc3c7" metalness={0.7} roughness={0.3} />
      </mesh>
      <mesh position={[-L / 2 + 6, PCB_TOP + 1.2, -W / 2 + 4]} castShadow>
        <boxGeometry args={[6, 2.4, 6]} />
        <meshStandardMaterial color="#d0d3d6" metalness={0.6} roughness={0.3} />
      </mesh>
      <FemaleHeader pins={8} at={[right - 3.5 * pitch, PCB_TOP, -W / 2 + 2.5]} />
      <FemaleHeader pins={10} at={[d8 - 4.5 * pitch, PCB_TOP, -W / 2 + 2.5]} />
      <FemaleHeader pins={6} at={[a0 + 2.5 * pitch, PCB_TOP, W / 2 - 2.5]} />
      <FemaleHeader pins={8} at={[a0 - 5.5 * pitch, PCB_TOP, W / 2 - 2.5]} />
      {/* "L" LED on D13 (yellow) and "ON" LED (green) — positions approx */}
      <mesh ref={led} position={[d8 - 6 * pitch, PCB_TOP + 0.4, -W / 2 + 9]}>
        <boxGeometry args={[1.6, 0.8, 0.8]} />
        <meshStandardMaterial color="#ffd24a" emissive="#ffc400" emissiveIntensity={0.05} />
      </mesh>
      <mesh position={[right - 2, PCB_TOP + 0.4, 4]}>
        <boxGeometry args={[1.6, 0.8, 0.8]} />
        <meshStandardMaterial color="#7dff9a" emissive="#1fe35a" emissiveIntensity={1.2} />
      </mesh>
    </group>
  );
}

// ───────────────────────── Parts ─────────────────────────

/** TowerPro SG90, standing with the output shaft up. Origin at the shaft axis on the desk. */
function Sg90({ angleRef, children }: { angleRef: () => number; children?: ReactNode }) {
  const horn = useRef<Group>(null);
  useFrame(() => {
    if (horn.current) horn.current.rotation.y = (angleRef() - 90) * DEG;
  });
  const { lengthMm: L, widthMm: W, heightMm: H, tabSpanMm } = SPEC.sg90;
  const shaftOffset = L / 2 - 5.9; // approx: shaft sits over one end of the case
  const body = (
    <meshPhysicalMaterial color="#2f6fe0" transmission={0.35} roughness={0.35} thickness={4} transparent opacity={0.88} />
  );
  return (
    <group>
      <group position={[shaftOffset, 0, 0]}>
        <mesh position={[0, (H - 4) / 2, 0]} castShadow>
          <boxGeometry args={[L, H - 4, W]} />
          {body}
        </mesh>
        <mesh position={[0, H - 9, 0]} castShadow>
          <boxGeometry args={[tabSpanMm, 2.5, W]} />
          {body}
        </mesh>
        {/* gear tower */}
        <mesh position={[-shaftOffset, H - 2, 0]} castShadow>
          <cylinderGeometry args={[W / 2, W / 2, 4, 32]} />
          {body}
        </mesh>
        {/* lead: brown GND, red +, orange signal */}
        {['#5a3a22', '#d22', '#f28c1a'].map((c, i) => (
          <mesh key={c} position={[L / 2 + 4, 4, (i - 1) * 1.1]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.5, 0.5, 8, 8]} />
            <meshStandardMaterial color={c} />
          </mesh>
        ))}
      </group>
      <mesh position={[0, H + 1, 0]}>
        <cylinderGeometry args={[2.4, 2.4, 2, 20]} />
        <meshStandardMaterial color="#f2f2f2" />
      </mesh>
      <group ref={horn} position={[0, H + 2, 0]}>
        <RoundedBox args={[17, 1.6, 5]} radius={0.7} position={[6, 0.8, 0]} castShadow>
          <meshStandardMaterial color="#f4f4f4" roughness={0.6} />
        </RoundedBox>
        <mesh position={[0, 1.2, 0]}>
          <cylinderGeometry args={[3.5, 3.5, 2.4, 24]} />
          <meshStandardMaterial color="#f4f4f4" roughness={0.6} />
        </mesh>
        {children}
      </group>
    </group>
  );
}

/** NEMA 17 (SY42STH47-1206A): 42.3 mm square × 48 mm, 5 mm D shaft along +z. Origin at the shaft axis on the front face. */
function Nema17({ angleRef, children }: { angleRef: () => number; children?: ReactNode }) {
  const shaft = useRef<Group>(null);
  useFrame(() => {
    if (shaft.current) shaft.current.rotation.z = angleRef() * DEG; // positive = counter-clockwise seen from the shaft end
  });
  const { frameMm: F, bodyMm: B, shaftDiaMm, shaftLenMmApprox } = SPEC.nema17;
  const cap = 8; // approx: end-cap thickness
  return (
    <group>
      <RoundedBox args={[F, F, cap]} radius={2.5} position={[0, 0, -cap / 2]} castShadow>
        <meshStandardMaterial color="#1d1f22" metalness={0.4} roughness={0.45} />
      </RoundedBox>
      <RoundedBox args={[F - 1, F - 1, B - 2 * cap]} radius={4} position={[0, 0, -B / 2]} castShadow>
        <meshStandardMaterial color="#9aa2aa" metalness={0.85} roughness={0.35} />
      </RoundedBox>
      <RoundedBox args={[F, F, cap]} radius={2.5} position={[0, 0, -B + cap / 2]} castShadow>
        <meshStandardMaterial color="#1d1f22" metalness={0.4} roughness={0.45} />
      </RoundedBox>
      <mesh position={[0, 0, 1]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[11, 11, 2, 40]} />
        <meshStandardMaterial color="#2a2d31" metalness={0.5} roughness={0.4} />
      </mesh>
      <mesh position={[0, -F / 2 - 3, -B + 6]} castShadow>
        <boxGeometry args={[12, 6, 6]} />
        <meshStandardMaterial color="#f3f3f3" roughness={0.6} />
      </mesh>
      <group ref={shaft}>
        <mesh position={[0, 0, shaftLenMmApprox / 2 + 2]} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <cylinderGeometry args={[shaftDiaMm / 2, shaftDiaMm / 2, shaftLenMmApprox, 24]} />
          <meshStandardMaterial color="#d7dbdf" metalness={0.95} roughness={0.15} />
        </mesh>
        {children}
      </group>
    </group>
  );
}

/** Pololu #1182 carrier on header pins. Origin at the board centre on the breadboard surface. */
function A4988Carrier() {
  const [L, W] = SPEC.a4988.boardMm;
  const lift = 6; // approx: header plastic + pins above a breadboard
  return (
    <group>
      <mesh position={[0, lift + 0.8, 0]} castShadow>
        <boxGeometry args={[L, 1.6, W]} />
        <meshStandardMaterial color="#1f7a3a" roughness={0.55} />
      </mesh>
      <mesh position={[0, lift + 2.1, 0]} castShadow>
        <boxGeometry args={[5, 0.9, 5]} />
        <meshStandardMaterial color="#111" roughness={0.4} />
      </mesh>
      <mesh position={[-6, lift + 2.2, 3.5]}>
        <cylinderGeometry args={[1.5, 1.5, 1.2, 16]} />
        <meshStandardMaterial color="#c9c9c9" metalness={0.6} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[0, lift / 2, (s * 12.7) / 2]}>
          <boxGeometry args={[L, lift, 2.5]} />
          <meshStandardMaterial color="#111" />
        </mesh>
      ))}
    </group>
  );
}

/** Omron B3F-1000: 6 × 6 mm body, ivory plunger, 4.3 mm overall. */
function TactSwitch({ pressedRef }: { pressedRef: () => boolean }) {
  const plunger = useRef<Mesh>(null);
  useFrame(() => {
    if (plunger.current) plunger.current.position.y = pressedRef() ? 3.3 : 3.6;
  });
  const S = SPEC.b3f.bodyMm;
  return (
    <group>
      <mesh position={[0, 1.6, 0]} castShadow>
        <boxGeometry args={[S, 3.2, S]} />
        <meshStandardMaterial color="#1a1a1a" roughness={0.6} />
      </mesh>
      <mesh position={[0, 3.25, 0]}>
        <boxGeometry args={[S, 0.1, S]} />
        <meshStandardMaterial color="#c8ccd0" metalness={0.9} roughness={0.3} />
      </mesh>
      <mesh ref={plunger} position={[0, 3.6, 0]} castShadow>
        <cylinderGeometry args={[1.75, 1.75, 1.4, 24]} />
        <meshStandardMaterial color="#f1ead6" roughness={0.5} />
      </mesh>
    </group>
  );
}

/** Bourns PTV09A-2 (vertical, 10 mm high) with a 20 mm flat shaft pointing at the viewer. */
function Pot({ valueRef }: { valueRef: () => number }) {
  const shaft = useRef<Group>(null);
  const { bodyMm, heightMm, shaftLenMm, mechanicalAngleDeg } = SPEC.ptv09;
  useFrame(() => {
    if (shaft.current) shaft.current.rotation.z = (0.5 - valueRef()) * mechanicalAngleDeg * DEG;
  });
  return (
    <group>
      <mesh position={[0, heightMm / 2, 0]} castShadow>
        <boxGeometry args={[bodyMm + 0.8, heightMm, 5]} />
        <meshStandardMaterial color="#2b4ea8" roughness={0.6} />
      </mesh>
      <group ref={shaft} position={[0, heightMm - 4.5, 2.5]}>
        <mesh position={[0, 0, shaftLenMm / 2]} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <cylinderGeometry args={[3, 3, shaftLenMm, 24]} />
          <meshStandardMaterial color="#e9e9e9" roughness={0.5} />
        </mesh>
        <mesh position={[0, 2.2, shaftLenMm - 2]}>
          <boxGeometry args={[0.8, 1.6, 4]} />
          <meshStandardMaterial color="#ff8a2a" />
        </mesh>
      </group>
    </group>
  );
}

/** Kingbright WP7113ID, 5 mm red diffused. */
function Led5mm({ levelRef, color }: { levelRef: () => number; color: string }) {
  const lens = useRef<Mesh>(null);
  useFrame(() => {
    const mat = lens.current?.material as MeshStandardMaterial | undefined;
    if (mat) mat.emissiveIntensity = 0.05 + levelRef() * 3;
  });
  const r = SPEC.wp7113id.lensMm / 2;
  return (
    <group position={[0, 3, 0]}>
      <mesh ref={lens} position={[0, 4, 0]} castShadow>
        <capsuleGeometry args={[r, 5, 8, 24]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.05} transparent opacity={0.9} />
      </mesh>
      <mesh position={[0, 0.5, 0]}>
        <cylinderGeometry args={[r + 0.4, r + 0.4, 1, 24]} />
        <meshStandardMaterial color={color} transparent opacity={0.9} />
      </mesh>
    </group>
  );
}

/** Generic half-size solderless breadboard — approx dimensions. */
const BREADBOARD = { pos: [-75, 0, 72] as V3, size: [82, 8.5, 55] as V3 };
function Breadboard() {
  const [L, H, W] = BREADBOARD.size;
  return (
    <group position={BREADBOARD.pos}>
      <RoundedBox args={[L, H, W]} radius={1} position={[0, H / 2, 0]} receiveShadow castShadow>
        <meshStandardMaterial color="#e6e4dc" roughness={0.8} />
      </RoundedBox>
      <mesh position={[0, H + 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[L - 4, 2.5]} />
        <meshStandardMaterial color="#cfcabd" />
      </mesh>
      {[-1, 1].map((s) => (
        <group key={s}>
          <mesh position={[0, H + 0.02, s * (W / 2 - 3)]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[L - 8, 0.6]} />
            <meshBasicMaterial color={s < 0 ? '#d33' : '#36c'} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// ───────────────────────── Wires ─────────────────────────

function Wire({ from, to, color, lift = 18 }: { from: V3; to: V3; color: string; lift?: number }) {
  const curve = useMemo(() => {
    const a = new Vector3(...from);
    const b = new Vector3(...to);
    const top = Math.max(a.y, b.y) + lift;
    return new CatmullRomCurve3([
      a,
      new Vector3(a.x, a.y + 4, a.z),
      new Vector3((a.x * 2 + b.x) / 3, top, (a.z * 2 + b.z) / 3),
      new Vector3((a.x + b.x * 2) / 3, top, (a.z + b.z * 2) / 3),
      new Vector3(b.x, b.y + 4, b.z),
      b,
    ]);
  }, [from, to, lift]);
  return (
    <mesh castShadow>
      <tubeGeometry args={[curve, 64, 0.6, 8, false]} />
      <meshStandardMaterial color={color} roughness={0.5} />
    </mesh>
  );
}

// ───────────────────────── Layout ─────────────────────────

const ON_BOARD = BREADBOARD.size[1];
const slot = (i: number): V3 => [-110 + i * 22, ON_BOARD, 72]; // breadboard positions for small parts

/** Two-joint arm: SG90 turns a printed turntable, a NEMA 17 on a printed bracket swings the link. */
function Arm({ sim, servoId, stepperId }: { sim: SimRef; servoId: string; stepperId: string }) {
  const servoAngle = () => sim.current?.part<Servo>(servoId)?.angle ?? 90;
  const stepAngle = () => sim.current?.part<StepperA4988>(stepperId)?.angle ?? 0;
  const { frameMm: F, bodyMm: B } = SPEC.nema17;
  return (
    <group position={[45, 0, 0]} rotation={[0, -0.6, 0]}>
      <RoundedBox args={[70, 6, 70]} radius={2} position={[0, 3, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={PRINTED} roughness={0.8} />
      </RoundedBox>
      <group position={[0, 6, 0]}>
        <Sg90 angleRef={servoAngle}>
          <mesh position={[0, 4, 0]} castShadow>
            <cylinderGeometry args={[32, 32, 4, 64]} />
            <meshStandardMaterial color={PRINTED} roughness={0.8} />
          </mesh>
          {/* face-mount bracket: the motor bolts to its front face, 30 mm above the turntable */}
          <RoundedBox args={[50, 30 + F, 8]} radius={1.5} position={[0, 6 + (30 + F) / 2, B / 2 + 4]} castShadow>
            <meshStandardMaterial color={PRINTED} roughness={0.8} />
          </RoundedBox>
          <group position={[0, 6 + 30 + F / 2, B / 2]}>
            <Nema17 angleRef={stepAngle}>
              <RoundedBox args={[110, 12, 6]} radius={2} position={[50, 0, SPEC.nema17.shaftLenMmApprox - 2]} castShadow>
                <meshStandardMaterial color={PRINTED} roughness={0.8} />
              </RoundedBox>
              <mesh position={[105, 0, SPEC.nema17.shaftLenMmApprox - 2]} castShadow>
                <sphereGeometry args={[8, 32, 32]} />
                <meshStandardMaterial color="#2f63c0" metalness={0.2} roughness={0.35} />
              </mesh>
            </Nema17>
          </group>
        </Sg90>
      </group>
    </group>
  );
}

export default function Scene({ sim, specs }: { sim: SimRef; specs: PartSpec[] }) {
  const servos = specs.filter((s) => s.type === 'servo');
  const steppers = specs.filter((s) => s.type === 'stepper');
  const arm = servos.length > 0 && steppers.length > 0 ? { servo: servos[0].id, stepper: steppers[0].id } : null;
  const builtin = specs.find((s) => s.type === 'led' && s.builtin && s.pin === 'D13');
  const small = specs.filter((s) => s.type === 'button' || s.type === 'pot' || (s.type === 'led' && !s.builtin) || s.type === 'stepper');
  const needsBreadboard = small.length > 0;

  const nodes: ReactNode[] = [];
  const wires: ReactNode[] = [];
  let free = 0; // x slots for stand-alone motors
  small.forEach((s, i) => {
    const at = slot(i);
    if (s.type === 'button') {
      nodes.push(
        <group key={s.id} position={at}>
          <TactSwitch pressedRef={() => sim.current?.part<Button>(s.id)?.pressed ?? false} />
        </group>,
      );
      wires.push(<Wire key={`${s.id}-w`} from={pinWorld(s.pin)} to={[at[0] - 3, at[1], at[2] - 6]} color="#f5d142" />);
      wires.push(<Wire key={`${s.id}-g`} from={pinWorld('GND')} to={[at[0] + 3, at[1], at[2] + 6]} color="#222" lift={10} />);
    } else if (s.type === 'pot') {
      nodes.push(
        <group key={s.id} position={at}>
          <Pot valueRef={() => sim.current?.part<Potentiometer>(s.id)?.value ?? 0.5} />
        </group>,
      );
      wires.push(<Wire key={`${s.id}-w`} from={pinWorld(s.pin)} to={[at[0], at[1], at[2] - 5]} color="#eaeaea" />);
      wires.push(<Wire key={`${s.id}-5`} from={pinWorld('5V')} to={[at[0] - 2.54, at[1], at[2] - 5]} color="#d33" lift={12} />);
    } else if (s.type === 'led') {
      nodes.push(
        <group key={s.id} position={at}>
          <Led5mm color={s.color ?? '#ff3b30'} levelRef={() => {
            const st = sim.current?.part<Led>(s.id)?.state();
            return st ? Math.max(st.on ? 1 : 0, Number(st.brightness)) : 0;
          }} />
        </group>,
      );
      wires.push(<Wire key={`${s.id}-w`} from={pinWorld(s.pin)} to={[at[0], at[1], at[2] - 4]} color="#4fc3f7" />);
    } else if (s.type === 'stepper') {
      nodes.push(
        <group key={`${s.id}-drv`} position={at}>
          <A4988Carrier />
        </group>,
      );
      wires.push(<Wire key={`${s.id}-s`} from={pinWorld(s.step)} to={[at[0] - 6, at[1] + 6, at[2] - 6.35]} color="#3d7bff" />);
      wires.push(<Wire key={`${s.id}-d`} from={pinWorld(s.dir)} to={[at[0] - 3.5, at[1] + 6, at[2] - 6.35]} color="#33c46b" />);
    }
  });

  for (const s of servos) {
    if (arm?.servo === s.id) continue;
    const x = 20 + free++ * 55;
    nodes.push(
      <group key={s.id} position={[x, 0, 0]}>
        <Sg90 angleRef={() => sim.current?.part<Servo>(s.id)?.angle ?? 90} />
      </group>,
    );
    wires.push(<Wire key={`${s.id}-w`} from={pinWorld(s.pin)} to={[x + 16, 4, 0]} color="#f28c1a" lift={22} />);
  }
  for (const s of steppers) {
    if (arm?.stepper === s.id) continue;
    const x = 20 + free++ * 55;
    nodes.push(
      <group key={s.id} position={[x, SPEC.nema17.frameMm / 2, 0]}>
        <Nema17 angleRef={() => sim.current?.part<StepperA4988>(s.id)?.angle ?? 0}>
          <RoundedBox args={[22, 6, 2]} radius={1} position={[9, 0, SPEC.nema17.shaftLenMmApprox - 2]} castShadow>
            <meshStandardMaterial color="#ffb02e" />
          </RoundedBox>
        </Nema17>
      </group>,
    );
  }
  if (arm) {
    nodes.push(<Arm key="arm" sim={sim} servoId={arm.servo} stepperId={arm.stepper} />);
    const s = servos[0];
    if (s.type === 'servo') wires.push(<Wire key="arm-w" from={pinWorld(s.pin)} to={[45 + 16, 12, 0]} color="#f28c1a" lift={22} />);
  }

  return (
    <Canvas shadows camera={{ position: [3, 27, 46], fov: 40 }} dpr={[1, 2]} gl={{ alpha: true }}>
      <ambientLight intensity={0.75} />
      <hemisphereLight args={["#ffffff", "#d8dde6", 0.6]} />
      <directionalLight position={[8, 16, 10]} intensity={1.7} castShadow shadow-mapSize={[2048, 2048]}>
        <orthographicCamera attach="shadow-camera" args={[-25, 25, 25, -25, 0.1, 60]} />
      </directionalLight>
      <pointLight position={[-10, 8, -6]} intensity={25} color="#ffffff" />
      <group scale={0.1}>
        <Uno sim={sim} builtinLedId={builtin?.id} />
        {needsBreadboard && <Breadboard />}
        {nodes}
        {wires}
      </group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[80, 80]} />
        <shadowMaterial opacity={0.16} />
      </mesh>
      <Grid args={[40, 40]} cellSize={1} cellColor="#c6d3ea" sectionSize={5} sectionColor="#7f9fd4" cellThickness={0.6} sectionThickness={1} fadeDistance={60} fadeStrength={1.5} infiniteGrid />
      <OrbitControls makeDefault target={[0, 7, 2]} maxPolarAngle={Math.PI / 2.05} />
    </Canvas>
  );
}

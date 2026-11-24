// 3D bench. Everything is modelled in millimetres from the datasheet figures in sim/catalog.ts; where a
// drawing was not readable the position is marked "approx". Only the parts in the current project are drawn,
// and each model reads its simulated part by id.
import { Grid, OrbitControls, RoundedBox } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { useMemo, useRef, type MutableRefObject, type ReactNode } from 'react';
import { CatmullRomCurve3, Vector3, type Group, type Mesh, type MeshStandardMaterial } from 'three';
import { DEVICES } from './lab/devices';
import type { LabSimulation } from './lab/labsim';
import type { Project } from './lab/project';
import { resistorBands } from './lab/Wiring';
import { SPEC } from './sim/catalog';

type SimRef = MutableRefObject<LabSimulation | null>;
type V3 = [number, number, number];

const DEG = Math.PI / 180;
const PRINTED = '#c9d3e2'; // custom 3D-printed parts (not in the BOM)

// ───────────────────────── Arduino UNO R3 ─────────────────────────

const UNO = SPEC.uno;
const UNO_POS: V3 = [0, 2, 0]; // lifted 2 mm: through-hole leads under the board (approx)
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

function Uno({ level }: { level: () => number }) {
  const led = useRef<Mesh>(null);
  useFrame(() => {
    const mat = led.current?.material as MeshStandardMaterial | undefined;
    if (!mat) return;
    mat.emissiveIntensity = 0.05 + level() * 4;
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

/** ¼ W resistor with its colour bands. */
function Resistor3D({ ohms }: { ohms: number }) {
  const bands = resistorBands(ohms);
  return (
    <group position={[0, 2.5, 0]} rotation={[0, 0, Math.PI / 2]}>
      <mesh castShadow>
        <capsuleGeometry args={[1.25, 4, 6, 16]} />
        <meshStandardMaterial color="#d8c49a" roughness={0.6} />
      </mesh>
      {bands.map((c, i) => (
        <mesh key={i} position={[0, -2.2 + i * 1.3 + (i === 3 ? 0.6 : 0), 0]}>
          <cylinderGeometry args={[1.3, 1.3, 0.5, 16]} />
          <meshStandardMaterial color={c} />
        </mesh>
      ))}
      <mesh>
        <cylinderGeometry args={[0.25, 0.25, 14, 6]} />
        <meshStandardMaterial color="#c9ccd0" metalness={0.8} />
      </mesh>
    </group>
  );
}

/** Radial electrolytic capacitor (size approx). */
function Cap3D() {
  return (
    <group>
      <mesh position={[0, 6.5, 0]} castShadow>
        <cylinderGeometry args={[4, 4, 11, 24]} />
        <meshStandardMaterial color="#1d3e8a" roughness={0.4} />
      </mesh>
      <mesh position={[0, 6.5, 3.6]}>
        <boxGeometry args={[2, 11, 1]} />
        <meshStandardMaterial color="#c9d3e2" />
      </mesh>
    </group>
  );
}

/** Bench supply (a generic box; size approx). */
function Psu3D({ volts }: { volts: number }) {
  return (
    <group>
      <RoundedBox args={[70, 40, 50]} radius={3} position={[0, 20, 0]} castShadow>
        <meshStandardMaterial color="#d7dbe0" roughness={0.6} />
      </RoundedBox>
      <mesh position={[-10, 28, 25.1]}>
        <planeGeometry args={[36, 12]} />
        <meshBasicMaterial color="#14301b" />
      </mesh>
      <mesh position={[-10 + 18 * Math.min(1, volts / 35) - 9, 28, 25.2]}>
        <planeGeometry args={[2, 8]} />
        <meshBasicMaterial color="#56f08a" />
      </mesh>
      <mesh position={[18, 12, 25.5]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[3, 3, 3, 16]} />
        <meshStandardMaterial color="#d33" />
      </mesh>
      <mesh position={[28, 12, 25.5]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[3, 3, 3, 16]} />
        <meshStandardMaterial color="#222" />
      </mesh>
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

/** Two-joint arm: SG90 turns a printed turntable, a NEMA 17 on a printed bracket swings the link. */
function Arm({ servoAngle, stepAngle }: { servoAngle: () => number; stepAngle: () => number }) {
  const { frameMm: F, bodyMm: B } = SPEC.nema17;
  return (
    <group rotation={[0, -0.6, 0]}>
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

const SPREAD = 4; // wiring-canvas units per millimetre on the bench (layout only)

export default function Scene({ sim, project }: { sim: SimRef; project: Project }) {
  const uno = project.devices.find((d) => d.kind === 'uno')!;
  const ucx = uno.x + DEVICES.uno.w / 2;
  const ucy = uno.y + DEVICES.uno.h / 2;
  const servo = project.devices.find((d) => d.kind === 'servo');
  const motor = project.devices.find((d) => d.kind === 'stepper');
  const arm = servo && motor ? { servo, motor } : null;

  const place = new Map<string, V3>();
  for (const d of project.devices) {
    if (d.kind === 'uno') continue;
    const def = DEVICES[d.kind];
    place.set(d.id, [(d.x + def.w / 2 - ucx) / SPREAD, 0, (d.y + def.h / 2 - ucy) / SPREAD]);
  }
  if (arm) place.set(arm.motor.id, place.get(arm.servo.id)!);

  const anchor = (ref: string): V3 | null => {
    const [id, pin] = ref.split('.');
    if (id === 'uno') return pinWorld(pin);
    const at = place.get(id);
    if (!at) return null;
    const d = project.devices.find((x) => x.id === id)!;
    const i = DEVICES[d.kind].pins.findIndex((p) => p.name === pin);
    const h = d.kind === 'psu' ? 12 : d.kind === 'stepper' ? 4 : d.kind === 'a4988' ? 8 : 3;
    return [at[0] - 6 + i * 2.54, at[1] + h, at[2] + (d.kind === 'psu' ? 26 : 0)];
  };

  const nodes: ReactNode[] = [];
  for (const d of project.devices) {
    const at = place.get(d.id);
    if (!at) continue;
    const id = d.id;
    let body: ReactNode = null;
    if (d.kind === 'servo') body = arm?.servo.id === id ? <Arm servoAngle={() => sim.current?.servos.get(id)?.angle ?? 90} stepAngle={() => sim.current?.motorAngle(arm.motor.id) ?? 0} /> : <Sg90 angleRef={() => sim.current?.servos.get(id)?.angle ?? 90} />;
    else if (d.kind === 'stepper') {
      if (arm?.motor.id === id) continue;
      body = (
        <group position={[0, SPEC.nema17.frameMm / 2, 0]}>
          <Nema17 angleRef={() => sim.current?.motorAngle(id) ?? 0}>
            <RoundedBox args={[22, 6, 2]} radius={1} position={[9, 0, SPEC.nema17.shaftLenMmApprox - 2]} castShadow>
              <meshStandardMaterial color="#ffb02e" />
            </RoundedBox>
          </Nema17>
        </group>
      );
    } else if (d.kind === 'a4988') body = <A4988Carrier />;
    else if (d.kind === 'button') body = <TactSwitch pressedRef={() => sim.current?.buttons.get(id)?.pressed ?? false} />;
    else if (d.kind === 'pot') body = <Pot valueRef={() => sim.current?.pots.get(id)?.value ?? 0.5} />;
    else if (d.kind === 'led') body = <Led5mm color={d.props.color ?? '#ff3b30'} levelRef={() => sim.current?.ledLevel(id) ?? 0} />;
    else if (d.kind === 'resistor') body = <Resistor3D ohms={d.props.ohms ?? 220} />;
    else if (d.kind === 'cap') body = <Cap3D />;
    else if (d.kind === 'psu') body = <Psu3D volts={d.props.volts ?? 12} />;
    nodes.push(
      <group key={id} position={at}>
        {body}
      </group>,
    );
  }

  const wires = project.wires.map((w) => {
    const a = anchor(w.a);
    const b = anchor(w.b);
    return a && b ? <Wire key={w.id} from={a} to={b} color={w.color} lift={14} /> : null;
  });

  return (
    <Canvas shadows camera={{ position: [10, 32, 52], fov: 40 }} dpr={[1, 2]} gl={{ alpha: true }}>
      <ambientLight intensity={0.75} />
      <hemisphereLight args={['#ffffff', '#d8dde6', 0.6]} />
      <directionalLight position={[8, 16, 10]} intensity={1.7} castShadow shadow-mapSize={[2048, 2048]}>
        <orthographicCamera attach="shadow-camera" args={[-35, 35, 35, -35, 0.1, 80]} />
      </directionalLight>
      <pointLight position={[-10, 8, -6]} intensity={25} color="#ffffff" />
      <group scale={0.1}>
        <Uno level={() => sim.current?.builtinLed() ?? 0} />
        {nodes}
        {wires}
      </group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[120, 120]} />
        <shadowMaterial opacity={0.16} />
      </mesh>
      <Grid args={[40, 40]} cellSize={1} cellColor="#c6d3ea" sectionSize={5} sectionColor="#7f9fd4" cellThickness={0.6} sectionThickness={1} fadeDistance={70} fadeStrength={1.5} infiniteGrid />
      <OrbitControls makeDefault target={[8, 8, 3]} maxPolarAngle={Math.PI / 2.05} />
    </Canvas>
  );
}

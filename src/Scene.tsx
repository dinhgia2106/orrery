// 3D bench. Everything is modelled in millimetres from the datasheet figures in sim/catalog.ts; where a
// drawing was not readable the position is marked "approx". Only the parts in the current project are drawn,
// and each model reads its simulated part by id.
import { Grid, OrbitControls, RoundedBox, TransformControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { BufferAttribute, BufferGeometry, CanvasTexture, CatmullRomCurve3, Color, DoubleSide, Material, Mesh as ThreeMesh, MeshBasicMaterial, MeshStandardMaterial as StdMaterial, Plane, RepeatWrapping, TubeGeometry, Euler, Matrix4, Quaternion, Vector3, type Group, type Mesh, type MeshStandardMaterial } from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { jointValues, type Assembly, type Joint, type Link, type Mount, type Vec3 } from './mech/assembly';
import { CableGeometry, sheathCurve } from './mech/cable';
import type { Dynamics } from './mech/dynamics';
import { linkFrames } from './mech/physics';
import { SPOOL, mountMatrix, tendonModels, tensionShare } from './mech/tendon';
import { partMesh } from './mech/fabricate';
import { DEVICES } from './lab/devices';
import type { LabSimulation } from './lab/labsim';
import type { Project } from './lab/project';
import { resistorBands } from './lab/Wiring';
import { SPEC } from './sim/catalog';

type SimRef = MutableRefObject<LabSimulation | null>;
type V3 = [number, number, number];

const DEG = Math.PI / 180;

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

function pinWorld(pin: string, at: V3 = UNO_POS): V3 {
  const [x, y, z] = headerLocal(pin);
  return [at[0] + x, at[1] + y, at[2] + z];
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

function Uno({ level, at = UNO_POS }: { level: () => number; at?: V3 }) {
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
    <group position={at}>
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

const SG90_SHAFT_OFFSET = SPEC.sg90.lengthMm / 2 - 5.9; // approx: shaft sits over one end of the case
/**
 * The SG90 lead, drawn as a short stub (its real length is not in the sources we have) ending in a 3-way
 * 2.54 mm-pitch housing that bench wires plug into: brown GND, red V+, orange signal, in that order.
 */
const SG90_LEAD_MM = 16;
const SG90_PLUG_MM = 8;
export function servoLeadLocal(pin: string): V3 {
  const i = Math.max(0, ['GND', 'V+', 'SIG'].indexOf(pin));
  return [SG90_SHAFT_OFFSET + SPEC.sg90.lengthMm / 2 + SG90_LEAD_MM + SG90_PLUG_MM, 4, (i - 1) * 2.54];
}

/** Groove radii of a two-groove spool: [the groove reeling in as the angle grows, the other]; 0 = groove unused. */
type SpoolRadii = [number, number];

/** Printed spool on an actuator shaft: two grooves (radii r) between three flanges (SPOOL in tendon.ts). Base at y = 0. */
function Spool({ r }: { r: SpoolRadii }) {
  const T = SPOOL.thicknessMm;
  const R = Math.max(r[0], r[1]);
  const hub = (rad: number, y0: number, y1: number) => (
    <mesh position={[0, (y0 + y1) / 2, 0]} castShadow>
      <cylinderGeometry args={[rad || R, rad || R, y1 - y0, 32]} />
      <meshStandardMaterial color="#f2f4f7" roughness={0.6} />
    </mesh>
  );
  return (
    <group>
      {hub(r[0], 0.8, 2.35)}
      {hub(r[1], 3.15, 4.7)}
      {[0.4, 2.75, 5.1].map((y) => (
        <mesh key={y} position={[0, y, 0]} castShadow>
          <cylinderGeometry args={[R + 1.5, R + 1.5, 0.8, 32]} />
          <meshStandardMaterial color="#dde2e9" roughness={0.6} />
        </mesh>
      ))}
      {/* the screw into the shaft, and a mark so the spool's turn shows */}
      <mesh position={[0, T + 0.3, 0]}>
        <cylinderGeometry args={[1.9, 1.9, 0.6, 16]} />
        <meshStandardMaterial color="#9aa2aa" metalness={0.8} roughness={0.3} />
      </mesh>
      <mesh position={[R * 0.6, T + 0.05, 0]}>
        <boxGeometry args={[R * 0.6, 0.2, 0.8]} />
        <meshStandardMaterial color="#1c4fa0" />
      </mesh>
    </group>
  );
}

/** Each actuator's spool, from the tendons it pulls. */
function spoolRadii(asm: Assembly): Map<string, SpoolRadii> {
  const out = new Map<string, SpoolRadii>();
  for (const t of asm.tendons ?? []) {
    const r = out.get(t.device) ?? [0, 0];
    r[t.wind === 1 ? 0 : 1] = Math.max(r[t.wind === 1 ? 0 : 1], t.spool);
    out.set(t.device, r);
  }
  return out;
}

/** TowerPro SG90, standing with the output shaft up. Origin at the shaft axis on the desk. With `spool`, a printed tendon spool replaces the horn. */
function Sg90({ angleRef, spool, children }: { angleRef: () => number; spool?: SpoolRadii; children?: ReactNode }) {
  const horn = useRef<Group>(null);
  useFrame(() => {
    if (horn.current) horn.current.rotation.y = (angleRef() - 90) * DEG;
  });
  const { lengthMm: L, widthMm: W, heightMm: H, tabSpanMm } = SPEC.sg90;
  const shaftOffset = SG90_SHAFT_OFFSET;
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
        {/* lead out of the case end: brown GND, red +, orange signal, into a 3-way housing */}
        {['#5a3a22', '#d22', '#f28c1a'].map((c, i) => (
          <mesh key={c} position={[L / 2 + SG90_LEAD_MM / 2, 4, (i - 1) * 1.1]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.5, 0.5, SG90_LEAD_MM, 8]} />
            <meshStandardMaterial color={c} />
          </mesh>
        ))}
        <mesh position={[L / 2 + SG90_LEAD_MM + SG90_PLUG_MM / 2, 4, 0]} castShadow>
          <boxGeometry args={[SG90_PLUG_MM, 2.5, 7.6]} />
          <meshStandardMaterial color="#1d1f22" roughness={0.5} />
        </mesh>
      </group>
      <mesh position={[0, H + 1, 0]}>
        <cylinderGeometry args={[2.4, 2.4, 2, 20]} />
        <meshStandardMaterial color="#f2f2f2" />
      </mesh>
      <group ref={horn} position={[0, SPOOL.servoSeatMm, 0]}>
        {spool ? (
          <Spool r={spool} />
        ) : (
          <>
            <RoundedBox args={[17, 1.6, 5]} radius={0.7} position={[6, 0.8, 0]} castShadow>
              <meshStandardMaterial color="#f4f4f4" roughness={0.6} />
            </RoundedBox>
            <mesh position={[0, 1.2, 0]}>
              <cylinderGeometry args={[3.5, 3.5, 2.4, 24]} />
              <meshStandardMaterial color="#f4f4f4" roughness={0.6} />
            </mesh>
          </>
        )}
        {children}
      </group>
    </group>
  );
}

/** NEMA 17 (SY42STH47-1206A): 42.3 mm square × 48 mm, 5 mm D shaft along +z. Origin at the shaft axis on the front face. */
function Nema17({ angleRef, spool, children }: { angleRef: () => number; spool?: SpoolRadii; children?: ReactNode }) {
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
        {spool && (
          <group position={[0, 0, SPOOL.stepperSeatMm]} rotation={[Math.PI / 2, 0, 0]}>
            <Spool r={spool} />
          </group>
        )}
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

function wireCurve(a: V3, b: V3, lift: number): CatmullRomCurve3 {
  const A = new Vector3(...a);
  const B = new Vector3(...b);
  const top = Math.max(A.y, B.y) + lift;
  return new CatmullRomCurve3([
    A,
    new Vector3(A.x, A.y + 4, A.z),
    new Vector3((A.x * 2 + B.x) / 3, top, (A.z * 2 + B.z) / 3),
    new Vector3((A.x + B.x * 2) / 3, top, (A.z + B.z * 2) / 3),
    new Vector3(B.x, B.y + 4, B.z),
    B,
  ]);
}

/** One mark on a plain background, repeated along a wire or line (u runs along it). */
function stripeTexture(bg: number, mark: number, markFrac: number): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 2;
  const g = c.getContext('2d')!;
  const tone = (v: number) => `rgb(${Math.round(v * 255)},${Math.round(v * 255)},${Math.round(v * 255)})`;
  g.fillStyle = tone(bg);
  g.fillRect(0, 0, 64, 2);
  g.fillStyle = tone(mark);
  g.fillRect(0, 0, Math.max(1, Math.round(64 * markFrac)), 2);
  const t = new CanvasTexture(c);
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  return t;
}

type NetLevel = () => { volts: number; edges: number } | null;

/**
 * A jumper wire. Its ends follow the parts they plug into; it glows with its net's voltage (full at 5 V) and,
 * while a board pin keeps switching the net (PWM, servo pulses, serial), marks run along it away from that pin.
 * The marks show activity, not how fast a signal travels.
 */
function Wire({ from, to, color, lift = 18, level, flow = 0 }: { from: (t: number) => V3 | null; to: (t: number) => V3 | null; color: string; lift?: number; level?: NetLevel; flow?: number }) {
  const mesh = useRef<Mesh>(null);
  const mat = useRef<MeshStandardMaterial>(null);
  const tex = useMemo(() => stripeTexture(0.25, 1, 0.3), []);
  const st = useRef({ a: null as V3 | null, b: null as V3 | null, edges: -1, act: 0 });
  const glow = useMemo(() => new Color(color).lerp(new Color('#ffffff'), 0.45), [color]);
  useEffect(() => () => tex.dispose(), [tex]);
  useFrame((state, dt) => {
    const a = from(state.clock.elapsedTime);
    const b = to(state.clock.elapsedTime);
    const m = mesh.current;
    if (!a || !b || !m) return;
    const S = st.current;
    const moved = (p: V3 | null, q: V3) => !p || Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 0.3;
    if (moved(S.a, a) || moved(S.b, b)) {
      S.a = a;
      S.b = b;
      const curve = wireCurve(a, b, lift);
      m.geometry.dispose();
      m.geometry = new TubeGeometry(curve, 64, 0.6, 8, false);
      tex.repeat.set(curve.getLength() / 14, 1);
    }
    const material = mat.current;
    if (!material) return;
    const lv = level?.();
    if (!lv) {
      material.emissiveIntensity = 0;
      return;
    }
    const switched = S.edges >= 0 && lv.edges !== S.edges;
    S.edges = lv.edges;
    S.act = switched ? 1 : S.act * Math.exp(-dt / 0.3);
    const v = Math.min(1.2, Math.max(0, Math.abs(lv.volts) / 5));
    material.emissiveIntensity = 0.06 + 0.3 * v + 0.6 * S.act;
    if (S.act > 0.05 && flow) tex.offset.x -= flow * dt * 2;
  });
  return (
    <mesh ref={mesh} castShadow>
      <bufferGeometry />
      <meshStandardMaterial ref={mat} color={color} roughness={0.5} emissive={glow} emissiveMap={tex} emissiveIntensity={0} />
    </mesh>
  );
}

// ───────────────────────── Tendons and axles ─────────────────────────

/** Link frames on the bench (mm) as they are drawn: from the dynamics when it runs, else from the joint values. */
function benchFrames(asm: Assembly, sim: SimRef, dyn?: MutableRefObject<Dynamics | null>): Map<string, Matrix4> {
  return dyn?.current ? dyn.current.frames() : linkFrames(asm, jointValues(asm, (dev) => deviceAngle(asm, sim, dev)));
}

function deviceAngle(asm: Assembly, sim: SimRef, dev: string): number | undefined {
  const s = sim.current;
  if (!s) return undefined;
  const servo = s.servos.get(dev);
  if (servo) return servo.angle;
  return asm.mounts?.some((m) => m.device === dev && m.kind === 'stepper') ? s.motorAngle(dev) : undefined;
}

/** Link frames for the current frame, computed once per frame however many parts ask. */
function useBenchFrames(asm: Assembly | undefined, sim: SimRef, dyn?: MutableRefObject<Dynamics | null>) {
  const cache = useRef<{ t: number; f: Map<string, Matrix4> | null }>({ t: -1, f: null });
  return useCallback(
    (t: number) => {
      if (!asm) return null;
      if (cache.current.t !== t || !cache.current.f) cache.current = { t, f: benchFrames(asm, sim, dyn) };
      return cache.current.f;
    },
    [asm, sim, dyn],
  );
}

const SLACK = new Color('#aab4c0');
const AMBER = new Color('#f0a020');
const RED = new Color('#e0322b');
const LINE_PERIOD_MM = 8;
const SHEATH_OD_MM = 3; // PTFE tube outer diameter: a design choice for the drawing

/**
 * Every tendon of the mechanism: the turns on its spool, the line through PTFE sheaths and guides to its anchor.
 * Its colour is the tension the actuator puts into it (grey none → amber half → red at stall); the marks on it
 * are fixed on the line, so they slide through the guides as the spool reels it in.
 */
function Tendons({ asm, sim, dyn, frames }: { asm: Assembly; sim: SimRef; dyn?: MutableRefObject<Dynamics | null>; frames: (t: number) => Map<string, Matrix4> | null }) {
  const models = useMemo(() => tendonModels(asm), [asm]);
  const lines = useMemo(() => models.map(() => new CableGeometry(160, 6, 0.35)), [models]);
  const sheaths = useMemo(() => models.map((m) => m.tendon.path.filter((p) => 'link' in p && p.sheath).map(() => new CableGeometry(28, 10, SHEATH_OD_MM / 2))), [models]);
  const mats = useRef<(MeshStandardMaterial | null)[]>([]);
  const tex = useMemo(() => {
    const t = stripeTexture(1, 0.55, 0.35);
    t.repeat.set(1 / LINE_PERIOD_MM, 1);
    return t;
  }, []);
  useEffect(
    () => () => {
      lines.forEach((g) => g.dispose());
      sheaths.flat().forEach((g) => g.dispose());
    },
    [lines, sheaths],
  );
  useFrame((state) => {
    const f = frames(state.clock.elapsedTime);
    if (!f) return;
    const efforts = dyn?.current ? dyn.current.actuatorEfforts() : null;
    models.forEach((m, i) => {
      const dev = m.tendon.device;
      const st = m.at(f, deviceAngle(asm, sim, dev) ?? m.homeAngle);
      // sheathed runs are drawn bent, leaving and entering along the free line on either side
      const pts: Vector3[] = [];
      const u: number[] = [];
      let sh = 0;
      for (let k = 0; k < st.points.length; k++) {
        if (k > 0 && st.sheathed[k - 1]) {
          const a = st.points[k - 1];
          const b = st.points[k];
          const ta = k >= 2 ? a.clone().sub(st.points[k - 2]) : b.clone().sub(a);
          const tb = k + 1 < st.points.length ? st.points[k + 1].clone().sub(b) : b.clone().sub(a);
          const curve = sheathCurve(a, b, ta, tb);
          sheaths[i][sh++]?.update(curve);
          const inner = curve.slice(1, -1);
          inner.forEach((p, j) => {
            pts.push(p);
            u.push(st.along[k - 1] + ((st.along[k] - st.along[k - 1]) * (j + 1)) / (inner.length + 1));
          });
        }
        pts.push(st.points[k]);
        u.push(st.along[k]);
      }
      lines[i].update(pts, u);
      const effort = efforts ? efforts.get(dev) : sim.current?.actuatorEffort(dev);
      const share = tensionShare(m.tendon, effort ?? 0);
      const c = share < 0.5 ? SLACK.clone().lerp(AMBER, share * 2) : AMBER.clone().lerp(RED, (share - 0.5) * 2);
      mats.current[i]?.color.copy(c);
    });
  });
  return (
    <>
      {models.map((m, i) => (
        <group key={m.tendon.id}>
          <mesh geometry={lines[i]} castShadow>
            <meshStandardMaterial ref={(x) => void (mats.current[i] = x)} color="#aab4c0" map={tex} roughness={0.55} />
          </mesh>
          {sheaths[i].map((g, k) => (
            <mesh key={k} geometry={g}>
              <meshPhysicalMaterial color="#f7f9fb" transparent opacity={0.4} roughness={0.25} depthWrite={false} />
            </mesh>
          ))}
        </group>
      ))}
    </>
  );
}

/**
 * Socket head cap screw used as a hinge axle, with its nut: head per ISO 4762 (M2: dk 3.8, k 2; M3: dk 5.5, k 3),
 * hex nut per ISO 4032 (M2: s 4, m 1.6; M3: s 5.5, m 2.4). Drawn in the parent link frame along the joint axis.
 */
const SCREW = { M2: { d: 2, dk: 3.8, k: 2, s: 4, m: 1.6 }, M3: { d: 3, dk: 5.5, k: 3, s: 5.5, m: 2.4 } };
function AxleScrew({ joint }: { joint: Joint }) {
  const q = useMemo(() => {
    const ax = new Vector3(...(joint.axis ?? [0, 0, 1])).normalize();
    const r = new Quaternion().setFromEuler(new Euler(...rad(joint.rotation)));
    return r.multiply(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), ax));
  }, [joint.axis, joint.rotation]);
  if (!joint.axle) return null;
  const sc = SCREW[joint.axle.size];
  const L = joint.axle.length;
  const steel = <meshStandardMaterial color="#8d959e" metalness={0.9} roughness={0.3} />;
  return (
    <group position={joint.position} quaternion={q}>
      <mesh castShadow>
        <cylinderGeometry args={[sc.d / 2, sc.d / 2, L, 16]} />
        {steel}
      </mesh>
      <mesh position={[0, -L / 2 - sc.k / 2, 0]} castShadow>
        <cylinderGeometry args={[sc.dk / 2, sc.dk / 2, sc.k, 20]} />
        {steel}
      </mesh>
      <mesh position={[0, L / 2 - sc.m / 2, 0]} castShadow>
        <cylinderGeometry args={[sc.s / Math.sqrt(3), sc.s / Math.sqrt(3), sc.m, 6]} />
        {steel}
      </mesh>
    </group>
  );
}

// ───────────────────────── Layout ─────────────────────────

// ───────────────────────── Assembly (Orrery Assembly Format) ─────────────────────────

const rad = (v?: Vec3): [number, number, number] => (v ? [v[0] * DEG, v[1] * DEG, v[2] * DEG] : [0, 0, 0]);
const MATERIAL_COLOR: Record<string, string> = { PLA: '#d9dee6', PETG: '#cfe0ea', TPU: '#3a3d42', ABS: '#e9e6df', resin: '#cfd2d6', aluminium: '#b9c0c8', steel: '#9aa2aa', acrylic: '#dfeef5', wood: '#c49a6c', other: '#c9ccd0' };

function StlMesh({ src, scale = 1, material }: { src: string; scale?: number; material: ReactNode }) {
  const [geo, setGeo] = useState<BufferGeometry | null>(null);
  useEffect(() => {
    let alive = true;
    new STLLoader().load(src, (g) => {
      g.computeVertexNormals();
      if (alive) setGeo(g);
    });
    return () => {
      alive = false;
    };
  }, [src]);
  return geo ? (
    <mesh geometry={geo} scale={scale} castShadow>
      {material}
    </mesh>
  ) : null;
}

const solidCache = new Map<string, Promise<BufferGeometry | null>>();

/** The exact printable solid (holes, pockets, bosses) as a flat-shaded geometry, cached by content. */
function solidGeometry(link: Link): Promise<BufferGeometry | null> {
  const key = JSON.stringify([link.shape, link.position, link.rotation, link.features]);
  let p = solidCache.get(key);
  if (!p) {
    p = partMesh(link).then((m) => {
      if (!m) return null;
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(m.positions, 3));
      g.setIndex(new BufferAttribute(m.triangles, 1));
      const flat = g.toNonIndexed();
      flat.computeVertexNormals();
      return flat;
    });
    if (solidCache.size > 200) solidCache.clear();
    solidCache.set(key, p);
  }
  return p;
}

function SolidMesh({ link, material, onClick }: { link: Link; material: ReactNode; onClick?: (e: { stopPropagation: () => void }) => void }) {
  const [geo, setGeo] = useState<BufferGeometry | null>(null);
  useEffect(() => {
    let alive = true;
    void solidGeometry(link).then((g) => alive && setGeo(g));
    return () => {
      alive = false;
    };
  }, [link]);
  return geo ? (
    <mesh geometry={geo} castShadow receiveShadow onClick={onClick}>
      {material}
    </mesh>
  ) : null;
}

function LinkShape({ link, selected, clash, onSelect }: { link: Link; selected?: boolean; clash?: boolean; onSelect?: (id: string) => void }) {
  const s = link.shape;
  const onClick = onSelect
    ? (e: { stopPropagation: () => void }) => {
        e.stopPropagation();
        onSelect(link.id);
      }
    : undefined;
  const material = (
    <meshStandardMaterial
      emissive={clash ? '#c2412d' : selected ? '#1c4fa0' : '#000000'}
      emissiveIntensity={clash ? 0.6 : selected ? 0.35 : 0}
      color={link.color ?? MATERIAL_COLOR[link.material ?? 'PLA']}
      roughness={link.material === 'aluminium' || link.material === 'steel' ? 0.35 : 0.75}
      metalness={link.material === 'aluminium' || link.material === 'steel' ? 0.8 : 0.05}
      transparent={link.opacity !== undefined && link.opacity < 1}
      opacity={link.opacity ?? 1}
      depthWrite={!(link.opacity !== undefined && link.opacity < 1)}
    />
  );
  if (link.features?.length && !('mesh' in s)) return <SolidMesh link={link} material={material} onClick={onClick} />;
  let body: ReactNode;
  if ('box' in s) body = <boxGeometry args={s.box} />;
  else if ('sphere' in s) body = <sphereGeometry args={[s.sphere, 32, 24]} />;
  else if ('cylinder' in s) body = <cylinderGeometry args={[s.cylinder.r, s.cylinder.r, s.cylinder.h, 40]} />;
  else if ('capsule' in s) body = <capsuleGeometry args={[s.capsule.r, s.capsule.h, 8, 24]} />;
  else {
    const src = s.mesh.data ?? s.mesh.url;
    return (
      <group position={link.position} rotation={rad(link.rotation)} onClick={onClick}>
        {src && <StlMesh src={src} scale={s.mesh.scale} material={material} />}
      </group>
    );
  }
  return (
    <mesh position={link.position} rotation={rad(link.rotation)} castShadow receiveShadow onClick={onClick}>
      {body}
      {material}
    </mesh>
  );
}

export interface LabControls {
  selected: string | null;
  onSelect: (id: string | null) => void;
  onMoveJoint: (jointId: string, position: Vec3) => void;
  onMovePlacement: (position: Vec3) => void;
  /** Parts found overlapping by the interference check. */
  clashing?: Set<string>;
}

const round1 = (v: Vector3): Vec3 => [Math.round(v.x * 10) / 10, Math.round(v.y * 10) / 10, Math.round(v.z * 10) / 10];

/** A frame the user can drag with a gizmo (1 mm steps); reports its new position on release. */
function Movable({ position, rotation, active, onMove, children }: { position: Vec3; rotation?: [number, number, number]; active: boolean; onMove: (p: Vec3) => void; children: ReactNode }) {
  const [obj, setObj] = useState<Group | null>(null);
  return (
    <>
      <group ref={setObj} position={position} rotation={rotation}>
        {children}
      </group>
      {active && obj && <TransformControls object={obj} mode="translate" translationSnap={1} size={0.7} onMouseUp={() => onMove(round1(obj.position))} />}
    </>
  );
}

/** The bench device a mount places on a link, with its live state. */
function MountedDevice({ mount, sim, spool }: { mount: Mount; sim: SimRef; spool?: SpoolRadii }) {
  const id = mount.device;
  switch (mount.kind) {
    case 'servo':
      return <Sg90 spool={spool} angleRef={() => sim.current?.servos.get(id)?.angle ?? 90} />;
    case 'stepper':
      return <Nema17 spool={spool} angleRef={() => sim.current?.motorAngle(id) ?? 0} />;
    case 'a4988':
      return <A4988Carrier />;
    case 'button':
      return <TactSwitch pressedRef={() => sim.current?.buttons.get(id)?.pressed ?? false} />;
    case 'pot':
      return <Pot valueRef={() => sim.current?.pots.get(id)?.value ?? 0.5} />;
    case 'led':
      return <Led5mm color="#ff3b30" levelRef={() => sim.current?.ledLevel(id) ?? 0} />;
    case 'resistor':
      return <Resistor3D ohms={220} />;
    case 'cap':
      return <Cap3D />;
    default:
      return null;
  }
}

/** Reads the device angles once per frame and shares the joint values with every joint. */
function useJointValues(asm: Assembly, sim: SimRef) {
  const cache = useRef({ frame: -1, values: new Map<string, number>() });
  return (frame: number) => {
    if (cache.current.frame !== frame) {
      const s = sim.current;
      cache.current = {
        frame,
        values: jointValues(asm, (d) => {
          if (!s) return undefined;
          const servo = s.servos.get(d);
          if (servo) return servo.angle;
          return asm.mounts?.some((m) => m.device === d && m.kind === 'stepper') ? s.motorAngle(d) : undefined;
        }),
      };
    }
    return cache.current.values;
  };
}

function JointNode({ joint, render, values, lab }: { joint: Joint; render: (link: string) => ReactNode; values: (frame: number) => Map<string, number>; lab?: LabControls }) {
  const moving = useRef<Group>(null);
  const axis = useMemo(() => new Vector3(...(joint.axis ?? [0, 0, 1])).normalize(), [joint.axis]);
  useFrame((state) => {
    const g = moving.current;
    if (!g || joint.type === 'fixed') return;
    const v = values(state.clock.elapsedTime).get(joint.id) ?? 0;
    if (joint.type === 'revolute') g.quaternion.setFromAxisAngle(axis, v * DEG);
    else g.position.copy(axis).multiplyScalar(v);
  });
  return (
    <Movable position={joint.position} rotation={rad(joint.rotation)} active={lab?.selected === joint.child} onMove={(p) => lab?.onMoveJoint(joint.id, p)}>
      <group ref={moving}>{render(joint.child)}</group>
    </Movable>
  );
}

/** The mechanism as Rapier moves it: every link at its own world pose, loose objects too. */
function DynamicAssemblyView({ asm, sim, dyn, lab }: { asm: Assembly; sim: SimRef; dyn: MutableRefObject<Dynamics | null>; lab?: LabControls }) {
  const groups = useRef(new Map<string, Group>());
  const loose = useRef<Group>(null);
  const last = useRef<number | null>(null);
  const [looseList, setLooseList] = useState<{ id: string; kind: 'ball' | 'box'; sizeMm: number }[]>([]);
  /** Parts in contact with another part, refreshed every few frames. */
  const [touching, setTouching] = useState<Set<string>>(new Set());
  const spools = useMemo(() => spoolRadii(asm), [asm]);
  const frame = useRef(0);
  useFrame((_, delta) => {
    const d = dyn.current;
    if (!d) return;
    const s = sim.current;
    // follow simulated time (pausing the bench pauses physics); without a bench, follow the clock
    const now = s ? s.time : (last.current ?? 0) + delta;
    const dt = last.current === null ? 0 : Math.min(0.05, Math.max(0, now - last.current));
    last.current = now;
    const stepper = new Set((asm.mounts ?? []).filter((m) => m.kind === 'stepper').map((m) => m.device));
    d.step(dt, (dev) => s?.servos.get(dev)?.angle ?? (stepper.has(dev) ? s?.motorAngle(dev) : undefined));
    for (const [id, pose] of d.poses()) {
      const g = groups.current.get(id);
      if (!g) continue;
      g.position.set(...pose.p);
      g.quaternion.set(...pose.q);
    }
    if (++frame.current % 6 === 0) {
      const now = new Set(d.touching().flatMap((t) => [t.a, t.b]));
      if (now.size !== touching.size || [...now].some((id) => !touching.has(id))) setTouching(now);
    }
    const lp = d.loosePoses();
    if (lp.length !== looseList.length) setLooseList(lp.map(({ id, kind, sizeMm }) => ({ id, kind, sizeMm })));
    lp.forEach((l, i) => {
      const g = loose.current?.children[i];
      if (g) (g.position.set(...l.pose.p), g.quaternion.set(...l.pose.q));
    });
  });
  return (
    <>
      {asm.links.map((link) => (
        <group key={link.id} ref={(g) => (g ? groups.current.set(link.id, g) : groups.current.delete(link.id))}>
          <LinkShape link={link} selected={lab?.selected === link.id} clash={lab?.clashing?.has(link.id) || touching.has(link.id)} onSelect={lab ? (x) => lab.onSelect(x) : undefined} />
          {(asm.mounts ?? [])
            .filter((m) => m.link === link.id)
            .map((m) => (
              <group key={m.device} position={m.position} rotation={rad(m.rotation)}>
                <MountedDevice mount={m} sim={sim} spool={spools.get(m.device)} />
              </group>
            ))}
          {asm.joints
            .filter((j) => j.parent === link.id && j.axle)
            .map((j) => (
              <AxleScrew key={j.id} joint={j} />
            ))}
        </group>
      ))}
      <group ref={loose}>
        {looseList.map((l) => (
          <mesh key={l.id} castShadow>
            {l.kind === 'ball' ? <sphereGeometry args={[l.sizeMm / 2, 32, 24]} /> : <boxGeometry args={[l.sizeMm, l.sizeMm, l.sizeMm]} />}
            <meshStandardMaterial color="#f5b942" roughness={0.6} />
          </mesh>
        ))}
      </group>
    </>
  );
}

function AssemblyView({ asm, sim, lab }: { asm: Assembly; sim: SimRef; lab?: LabControls }) {
  const values = useJointValues(asm, sim);
  const byParent = useMemo(() => {
    const m = new Map<string, Joint[]>();
    for (const j of asm.joints) m.set(j.parent, [...(m.get(j.parent) ?? []), j]);
    return m;
  }, [asm]);
  const root = asm.links.find((l) => !asm.joints.some((j) => j.child === l.id))!;
  const spools = useMemo(() => spoolRadii(asm), [asm]);
  const render = (id: string): ReactNode => {
    const link = asm.links.find((l) => l.id === id)!;
    return (
      <>
        <LinkShape link={link} selected={lab?.selected === id} clash={lab?.clashing?.has(id)} onSelect={lab ? (x) => lab.onSelect(x) : undefined} />
        {(asm.mounts ?? [])
          .filter((m) => m.link === id)
          .map((m) => (
            <group key={m.device} position={m.position} rotation={rad(m.rotation)}>
              <MountedDevice mount={m} sim={sim} spool={spools.get(m.device)} />
            </group>
          ))}
        {(byParent.get(id) ?? [])
          .filter((j) => j.axle)
          .map((j) => (
            <AxleScrew key={`${j.id}-axle`} joint={j} />
          ))}
        {(byParent.get(id) ?? []).map((j) => (
          <JointNode key={j.id} joint={j} render={render} values={values} lab={lab} />
        ))}
      </>
    );
  };
  return (
    <Movable position={asm.placement ?? [150, 0, 0]} active={lab?.selected === root.id} onMove={(p) => lab?.onMovePlacement(p)}>
      {render(root.id)}
    </Movable>
  );
}

/** Every link frame of an assembly at home pose, on the bench in mm. */
function linkOrigins(asm: Assembly): Vector3[] {
  const parentJoint = new Map(asm.joints.map((j) => [j.child, j]));
  const local = (pos?: Vec3, rot?: Vec3) => new Matrix4().compose(new Vector3(...(pos ?? [0, 0, 0])), new Quaternion().setFromEuler(new Euler(...rad(rot))), new Vector3(1, 1, 1));
  return asm.links.map((l) => {
    let mat = local(l.position);
    let link = l.id;
    for (let guard = 0; guard < 400; guard++) {
      const j = parentJoint.get(link);
      if (!j) break;
      mat = local(j.position, j.rotation).multiply(mat);
      link = j.parent;
    }
    return new Vector3().setFromMatrixPosition(local(asm.placement ?? [150, 0, 0]).multiply(mat));
  });
}

/** Camera target and position (scene units = cm) that frame the boards, parts and mechanism on the bench. */
function benchFrame(project: Project): { target: V3; camera: V3 } {
  const pts: Vector3[] = [];
  const uno = project.devices.find((d) => d.kind === 'uno');
  const ucx = uno ? uno.x + DEVICES.uno.w / 2 : DEVICES.uno.w / 2;
  const ucy = uno ? uno.y + DEVICES.uno.h / 2 : DEVICES.uno.h / 2;
  for (const d of project.devices) {
    const k = d.kind === 'uno' ? 5 : SPREAD;
    pts.push(new Vector3((d.x + DEVICES[d.kind].w / 2 - ucx) / k, 0, (d.y + DEVICES[d.kind].h / 2 - ucy) / k));
  }
  if (project.assembly) pts.push(...linkOrigins(project.assembly));
  if (!pts.length) pts.push(new Vector3(0, 0, 0));
  const min = pts.reduce((a, p) => a.min(p), pts[0].clone());
  const max = pts.reduce((a, p) => a.max(p), pts[0].clone());
  const c = min.clone().add(max).multiplyScalar(0.5);
  const size = Math.max(250, max.clone().sub(min).length() + 80); // mm, with room for the parts around the frames
  const t: V3 = [c.x / 10, Math.max(2, c.y / 10), c.z / 10];
  const d = (size / 10) * 1.15;
  return { target: t, camera: [t[0] + d * 0.25, t[1] + d * 0.55, t[2] + d * 1.0] };
}

const SPREAD = 4; // wiring-canvas units per millimetre on the bench (layout only)

/** A section cut through the whole bench: everything on one side of the plane is hidden. */
export interface Section {
  on: boolean;
  axis: 'x' | 'y' | 'z';
  /** Plane position on the bench, mm. */
  offset: number;
  /** Keep the other side. */
  flip: boolean;
}

const CUT_COLOR = 'vec4(0.76, 0.25, 0.18, 1.0)';

/** Show the inside of solids where the plane cuts them: back faces drawn in the section colour. */
function sectionize(m: Material) {
  if (m.userData.section || !(m instanceof StdMaterial || m instanceof MeshBasicMaterial)) return;
  m.userData.section = true;
  m.side = DoubleSide;
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(/}\s*$/, `  if (!gl_FrontFacing) gl_FragColor = ${CUT_COLOR};\n}`);
  };
  m.needsUpdate = true;
}

function SectionCut({ section }: { section?: Section }) {
  const { gl, scene } = useThree();
  const plane = useMemo(() => new Plane(), []);
  const frame = useRef(0);
  const on = !!section?.on;
  const unit = new Vector3(section?.axis === 'x' ? 1 : 0, section?.axis === 'y' ? 1 : 0, section?.axis === 'z' ? 1 : 0);
  const at = (section?.offset ?? 0) / 10; // scene units are cm
  useEffect(() => {
    if (!on) {
      gl.clippingPlanes = [];
      return;
    }
    // keep the side the normal points to: n·p − n·(at·u) ≥ 0
    const n = unit.clone().multiplyScalar(section!.flip ? 1 : -1);
    plane.set(n, -n.dot(unit.clone().multiplyScalar(at)));
    gl.clippingPlanes = [plane];
    return () => {
      gl.clippingPlanes = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, section?.axis, section?.offset, section?.flip, gl, plane]);
  // parts load asynchronously (printable solids, STL), so keep preparing new materials while the cut is on
  useFrame(() => {
    if (!on || frame.current++ % 30) return;
    scene.traverse((o) => {
      if ((o as ThreeMesh).isMesh && !o.userData.sectionPlane) {
        const mat = (o as ThreeMesh).material;
        (Array.isArray(mat) ? mat : [mat]).forEach(sectionize);
      }
    });
  });
  if (!on) return null;
  const rot: [number, number, number] = section!.axis === 'x' ? [0, Math.PI / 2, 0] : section!.axis === 'y' ? [-Math.PI / 2, 0, 0] : [0, 0, 0];
  const pos = unit.clone().multiplyScalar(at + (section!.flip ? 0.01 : -0.01)).toArray() as V3;
  if (section!.axis !== 'y') pos[1] = 25;
  return (
    <mesh position={pos} rotation={rot} userData={{ sectionPlane: true }} renderOrder={10}>
      <planeGeometry args={[120, 120]} />
      <meshBasicMaterial color="#1c4fa0" transparent opacity={0.06} depthWrite={false} side={DoubleSide} clippingPlanes={[]} />
    </mesh>
  );
}

/** The jumper wires (ends following moving parts) and the mechanism's tendons. */
function BenchWires({ project, sim, dyn, anchor, isBoard, showWires = true, showTendons = true }: { project: Project; sim: SimRef; dyn?: MutableRefObject<Dynamics | null>; anchor: (ref: string, frames: (t: number) => Map<string, Matrix4> | null) => (t: number) => V3 | null; isBoard: (ref: string) => boolean; showWires?: boolean; showTendons?: boolean }) {
  const asm = project.assembly;
  const frames = useBenchFrames(asm, sim, dyn);
  return (
    <>
      {showWires &&
        project.wires.map((w) => (
          <Wire
            key={w.id}
            from={anchor(w.a, frames)}
            to={anchor(w.b, frames)}
            color={w.color}
            lift={14}
            flow={isBoard(w.a) ? 1 : isBoard(w.b) ? -1 : 0}
            level={() => sim.current?.netState(w.a) ?? null}
          />
        ))}
      {showTendons && asm?.tendons?.length ? <Tendons asm={asm} sim={sim} dyn={dyn} frames={frames} /> : null}
    </>
  );
}

type Controls = { target: Vector3; update: () => void; enabled: boolean } | null;

/**
 * Camera that the user owns: the view is framed once per bench layout (not on every render, which pinned the
 * orbit centre), the wheel zooms towards the cursor, double-clicking a part flies to it, and `fitKey` reframes.
 */
function CameraRig({ frame, fitKey, focus }: { frame: { target: V3; camera: V3 }; fitKey: string; focus: MutableRefObject<Vector3 | null> }) {
  const controls = useThree((s) => s.controls) as unknown as Controls;
  const camera = useThree((s) => s.camera);
  const goal = useRef<{ target: Vector3; camera: Vector3 } | null>(null);
  const first = useRef(true);
  useEffect(() => {
    if (!controls) return;
    goal.current = { target: new Vector3(...frame.target), camera: new Vector3(...frame.camera) };
    if (first.current) {
      // the first framing is immediate; later ones (fit view, a new layout) glide
      first.current = false;
      controls.target.copy(goal.current.target);
      camera.position.copy(goal.current.camera);
      controls.update();
      goal.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controls, fitKey]);
  useFrame(() => {
    if (!controls) return;
    const f = focus.current;
    if (f) {
      // keep the viewing direction, come in to about 12 cm (120 mm) unless already closer
      const dir = camera.position.clone().sub(controls.target);
      const dist = Math.min(dir.length(), 12);
      goal.current = { target: f.clone(), camera: f.clone().add(dir.normalize().multiplyScalar(dist)) };
      focus.current = null;
    }
    const g = goal.current;
    if (!g) return;
    controls.target.lerp(g.target, 0.2);
    camera.position.lerp(g.camera, 0.2);
    controls.update();
    if (controls.target.distanceTo(g.target) < 0.01 && camera.position.distanceTo(g.camera) < 0.01) goal.current = null;
  });
  return null;
}

export default function Scene({ sim, project, lab, section, dyn, fitKey = 0, showWires = true, showTendons = true }: { sim: SimRef; project: Project; lab?: LabControls; section?: Section; dyn?: MutableRefObject<Dynamics | null>; fitKey?: number; showWires?: boolean; showTendons?: boolean }) {
  // the bench is laid out around the board's centre (or the canvas origin when there is no board)
  const uno = project.devices.find((d) => d.kind === 'uno');
  const ucx = uno ? uno.x + DEVICES.uno.w / 2 : DEVICES.uno.w / 2;
  const ucy = uno ? uno.y + DEVICES.uno.h / 2 : DEVICES.uno.h / 2;
  const asm = project.assembly;
  // look at the bench when there is a board, else at the mechanism (scene units are cm)
  const frame = benchFrame(project);
  const focus = useRef<Vector3 | null>(null);
  const mounted = new Set((asm?.mounts ?? []).map((m) => m.device));

  const place = new Map<string, V3>();
  for (const d of project.devices) {
    const def = DEVICES[d.kind];
    // boards keep their real size, so they sit at their canvas offset in mm (5 canvas units per mm)
    const k = d.kind === 'uno' ? 5 : SPREAD;
    place.set(d.id, d.id === uno?.id ? UNO_POS : [(d.x + def.w / 2 - ucx) / k, d.kind === 'uno' ? UNO_POS[1] : 0, (d.y + def.h / 2 - ucy) / k]);
  }
  const boards = project.devices.filter((d) => d.kind === 'uno');

  /** Where a wire end plugs in: a header pin or a part's lead — following a part mounted on a moving link. */
  const anchor = (ref: string, frames: (t: number) => Map<string, Matrix4> | null): ((t: number) => V3 | null) => {
    const [id, pin] = ref.split('.');
    const board = boards.find((b) => b.id === id);
    if (board) {
      const p = pinWorld(pin, place.get(board.id));
      return () => p;
    }
    const m = asm?.mounts?.find((x) => x.device === id);
    if (m) {
      const local = new Vector3(...(m.kind === 'servo' ? servoLeadLocal(pin) : [0, 4, 0]));
      const mm = mountMatrix(m);
      return (t) => {
        const f = frames(t)?.get(m.link);
        if (!f) return null;
        const v = local.clone().applyMatrix4(f.clone().multiply(mm));
        return [v.x, v.y, v.z];
      };
    }
    const at = place.get(id);
    if (!at) return () => null;
    const d = project.devices.find((x) => x.id === id)!;
    if (d.kind === 'servo') {
      const l = servoLeadLocal(pin);
      const p: V3 = [at[0] + l[0], at[1] + l[1], at[2] + l[2]];
      return () => p;
    }
    const i = DEVICES[d.kind].pins.findIndex((p) => p.name === pin);
    const h = d.kind === 'psu' ? 12 : d.kind === 'stepper' ? 4 : d.kind === 'a4988' ? 8 : 3;
    const p: V3 = [at[0] - 6 + i * 2.54, at[1] + h, at[2] + (d.kind === 'psu' ? 26 : 0)];
    return () => p;
  };
  const isBoard = (ref: string) => boards.some((b) => b.id === ref.split('.')[0]);

  const nodes: ReactNode[] = [];
  for (const d of project.devices) {
    const at = place.get(d.id);
    if (!at || mounted.has(d.id) || d.kind === 'uno') continue;
    const id = d.id;
    let body: ReactNode = null;
    if (d.kind === 'servo') body = <Sg90 angleRef={() => sim.current?.servos.get(id)?.angle ?? 90} />;
    else if (d.kind === 'stepper') {
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

  const layoutKey = `${frame.target.join(',')}|${frame.camera.join(',')}`;
  return (
    <Canvas shadows camera={{ position: frame.camera, fov: 40, near: 0.05, far: 2000 }} dpr={[1, 2]} gl={{ alpha: true }}>
      <ambientLight intensity={0.75} />
      <hemisphereLight args={['#ffffff', '#d8dde6', 0.6]} />
      <directionalLight position={[8, 16, 10]} intensity={1.7} castShadow shadow-mapSize={[2048, 2048]}>
        <orthographicCamera attach="shadow-camera" args={[-35, 35, 35, -35, 0.1, 80]} />
      </directionalLight>
      <pointLight position={[-10, 8, -6]} intensity={25} color="#ffffff" />
      <group
        scale={0.1}
        onDoubleClick={(e) => {
          e.stopPropagation();
          focus.current = e.point.clone();
        }}
      >
        {boards.map((b) => (
          <Uno key={b.id} at={place.get(b.id)} level={() => sim.current?.builtinLed(b.id) ?? 0} />
        ))}
        {asm && (dyn?.current ? <DynamicAssemblyView asm={asm} sim={sim} dyn={dyn} lab={lab} /> : <AssemblyView asm={asm} sim={sim} lab={lab} />)}
        {nodes}
        <BenchWires project={project} sim={sim} dyn={dyn} anchor={anchor} isBoard={isBoard} showWires={showWires} showTendons={showTendons} />
      </group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[120, 120]} />
        <shadowMaterial opacity={0.16} />
      </mesh>
      <Grid args={[40, 40]} cellSize={1} cellColor="#c6d3ea" sectionSize={5} sectionColor="#7f9fd4" cellThickness={0.6} sectionThickness={1} fadeDistance={70} fadeStrength={1.5} infiniteGrid />
      <SectionCut section={section} />
      <OrbitControls makeDefault zoomToCursor minDistance={0.3} maxDistance={400} maxPolarAngle={Math.PI / 2.05} />
      <CameraRig frame={frame} fitKey={`${layoutKey}#${fitKey}`} focus={focus} />
    </Canvas>
  );
}

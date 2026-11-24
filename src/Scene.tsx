import { Grid, OrbitControls, RoundedBox } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { useRef, type MutableRefObject } from 'react';
import type { Group, Mesh, MeshStandardMaterial } from 'three';
import type { Simulation } from './sim/engine';
import { Led, Servo, StepperA4988 } from './sim/parts';

type SimRef = MutableRefObject<Simulation | null>;

const DEG = Math.PI / 180;

/** The two-joint arm: base yaw from the first servo, elbow pitch from the first stepper. */
function Arm({ sim }: { sim: SimRef }) {
  const base = useRef<Group>(null);
  const elbow = useRef<Group>(null);
  useFrame(() => {
    const s = sim.current;
    const servo = s?.parts.find((p): p is Servo => p instanceof Servo);
    const stepper = s?.parts.find((p): p is StepperA4988 => p instanceof StepperA4988);
    if (base.current) base.current.rotation.y = servo ? (servo.angle - 90) * DEG : 0;
    if (elbow.current) elbow.current.rotation.z = stepper ? -stepper.angle * DEG : 0;
  });
  return (
    <group position={[1.5, 0, 0]}>
      <mesh position={[0, 0.25, 0]} castShadow>
        <cylinderGeometry args={[1.1, 1.3, 0.5, 48]} />
        <meshStandardMaterial color="#2a3340" metalness={0.6} roughness={0.35} />
      </mesh>
      <group ref={base} position={[0, 0.5, 0]}>
        <mesh position={[0, 0.25, 0]} castShadow>
          <cylinderGeometry args={[0.75, 0.75, 0.5, 40]} />
          <meshStandardMaterial color="#f5b942" metalness={0.3} roughness={0.4} />
        </mesh>
        <RoundedBox args={[0.5, 2.6, 0.5]} radius={0.08} position={[0, 1.8, 0]} castShadow>
          <meshStandardMaterial color="#e8edf3" metalness={0.2} roughness={0.5} />
        </RoundedBox>
        <group ref={elbow} position={[0, 3.1, 0]}>
          <mesh rotation={[Math.PI / 2, 0, 0]} castShadow>
            <cylinderGeometry args={[0.38, 0.38, 0.7, 32]} />
            <meshStandardMaterial color="#1c2430" metalness={0.7} roughness={0.3} />
          </mesh>
          <RoundedBox args={[2.4, 0.4, 0.4]} radius={0.08} position={[1.2, 0, 0]} castShadow>
            <meshStandardMaterial color="#e8edf3" metalness={0.2} roughness={0.5} />
          </RoundedBox>
          <mesh position={[2.5, 0, 0]} castShadow>
            <sphereGeometry args={[0.28, 32, 32]} />
            <meshStandardMaterial color="#5ad1ff" emissive="#1e8fbf" emissiveIntensity={0.6} />
          </mesh>
        </group>
      </group>
    </group>
  );
}

/** Arduino Uno outline with the board LEDs. */
function Board({ sim }: { sim: SimRef }) {
  const led = useRef<Mesh>(null);
  useFrame(() => {
    const l = sim.current?.parts.find((p): p is Led => p instanceof Led);
    const mat = led.current?.material as MeshStandardMaterial | undefined;
    if (!mat) return;
    const st = l?.state();
    const level = st ? Math.max(st.on ? 1 : 0, Number(st.brightness)) : 0;
    mat.emissiveIntensity = 0.05 + level * 3;
  });
  return (
    <group position={[-4.2, 0, 0.5]} rotation={[0, 0.35, 0]}>
      <RoundedBox args={[3.4, 0.16, 2.65]} radius={0.05} position={[0, 0.08, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#0f6f8f" roughness={0.6} />
      </RoundedBox>
      <mesh position={[0.2, 0.26, 0.2]} castShadow>
        <boxGeometry args={[1.4, 0.18, 0.4]} />
        <meshStandardMaterial color="#151515" roughness={0.4} />
      </mesh>
      <mesh position={[-1.5, 0.3, 0.55]} castShadow>
        <boxGeometry args={[0.6, 0.45, 0.55]} />
        <meshStandardMaterial color="#b9c1c9" metalness={0.8} roughness={0.25} />
      </mesh>
      <mesh ref={led} position={[0.9, 0.22, -0.9]}>
        <boxGeometry args={[0.14, 0.08, 0.1]} />
        <meshStandardMaterial color="#ffb37a" emissive="#ff7a1a" emissiveIntensity={0.05} />
      </mesh>
    </group>
  );
}

export default function Scene({ sim }: { sim: SimRef }) {
  return (
    <Canvas shadows camera={{ position: [4.5, 6.5, 11], fov: 42 }} dpr={[1, 2]}>
      <color attach="background" args={['#0b0f14']} />
      <ambientLight intensity={0.45} />
      <directionalLight position={[6, 10, 6]} intensity={1.6} castShadow shadow-mapSize={[2048, 2048]} />
      <pointLight position={[-6, 4, -4]} intensity={30} color="#5ad1ff" />
      <Board sim={sim} />
      <Arm sim={sim} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[60, 60]} />
        <shadowMaterial opacity={0.35} />
      </mesh>
      <Grid args={[40, 40]} cellSize={0.5} cellColor="#1b2633" sectionSize={2.5} sectionColor="#24384d" fadeDistance={30} infiniteGrid />
      <OrbitControls makeDefault target={[-1.2, 1.4, 0]} maxPolarAngle={Math.PI / 2.05} />
    </Canvas>
  );
}

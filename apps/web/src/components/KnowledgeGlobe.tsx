import { useEffect, useMemo, useRef, useState } from "react";
import type { KnowledgeNode } from "@noosphere/domain";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Stars } from "@react-three/drei";
import * as THREE from "three";

type Props = {
  nodes: readonly KnowledgeNode[];
  selected?: KnowledgeNode;
  onSelect: (node: KnowledgeNode) => void;
  compact?: boolean;
  orbitEnabled?: boolean;
};

const PARENT_ONLY_DISTANCE = 3.05;
const CHILD_REVEAL_DISTANCE = 1.85;
const CHILD_BLOOM_DISTANCE = 0.18;

function smoothStep(edge0: number, edge1: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function KnowledgeGlobe({ nodes, selected, onSelect, compact = false, orbitEnabled = true }: Props) {
  const orbitControlsRef = useRef<any>(null);

  return (
    <Canvas camera={{ position: [0, 0.1, compact ? 3.4 : 3.15], fov: compact ? 48 : 42 }} dpr={[1, 1.75]}>
      <color attach="background" args={[compact ? "#0b1512" : "#07100d"]} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[4, 3, 5]} intensity={2.4} color="#b6ffe0" />
      <pointLight position={[-4, -1, 2]} intensity={1.2} color="#426fef" />
      {!compact && <Stars radius={45} depth={24} count={900} factor={1.1} saturation={0.3} fade speed={0.2} />}
      <Globe nodes={nodes} selected={selected} onSelect={onSelect} compact={compact} />
      {selected && <CameraFocus node={selected} />}
      <OrbitControls
        ref={orbitControlsRef}
        makeDefault
        enabled={!selected && orbitEnabled}
        enablePan={false}
        minDistance={2.1}
        maxDistance={4.5}
        autoRotate={!selected && !compact && orbitEnabled}
        autoRotateSpeed={0.25}
      />
    </Canvas>
  );
}

function Globe({ nodes, selected, onSelect, compact }: { nodes: readonly KnowledgeNode[]; selected?: KnowledgeNode; onSelect: Props["onSelect"]; compact: boolean }) {
  const group = useRef<THREE.Group>(null);
  useFrame((_, delta) => {
    if (group.current && compact) group.current.rotation.y += delta * 0.04;
  });

  const parentNodes = useMemo(() => nodes.filter((node) => node.nodeKind !== "micro"), [nodes]);
  const microNodes = useMemo(() => nodes.filter((node) => node.nodeKind === "micro"), [nodes]);
  const microMap = useMemo(() => {
    const map = new Map<string, KnowledgeNode[]>();
    microNodes.forEach((node) => {
      if (!node.parentId) return;
      const list = map.get(node.parentId) ?? [];
      list.push(node);
      map.set(node.parentId, list);
    });
    return map;
  }, [microNodes]);

  return (
    <group ref={group}>
      <mesh>
        <sphereGeometry args={[1, 64, 64]} />
        <meshStandardMaterial color="#10231d" roughness={0.72} metalness={0.12} transparent opacity={0.92} />
      </mesh>
      <mesh scale={1.006}>
        <sphereGeometry args={[1, 32, 24]} />
        <meshBasicMaterial color="#285341" wireframe transparent opacity={0.17} />
      </mesh>
      {parentNodes.map((parent) => (
        <ParentMacroNode
          key={parent.id}
          macro={parent}
          children={microMap.get(parent.id) ?? []}
          selected={selected}
          onSelect={onSelect}
          compact={compact}
        />
      ))}
    </group>
  );
}

function ParentMacroNode({
  macro,
  children,
  selected,
  onSelect,
  compact
}: {
  macro: KnowledgeNode;
  children: KnowledgeNode[];
  selected?: KnowledgeNode;
  onSelect: Props["onSelect"];
  compact: boolean;
}) {
  const group = useRef<THREE.Group>(null);
  const [hovered, setHovered] = useState(false);
  const [revealRatio, setRevealRatio] = useState(0);
  const { camera } = useThree();
  const parentPos = useMemo(() => new THREE.Vector3(...macro.position), [macro.position]);
  const isActive = hovered || selected?.id === macro.id || selected?.parentId === macro.id;

  useFrame((_, delta) => {
    if (!group.current) return;
    const distance = camera.position.distanceTo(parentPos);
    const proximityReveal = 1 - smoothStep(CHILD_REVEAL_DISTANCE, PARENT_ONLY_DISTANCE, distance);
    const targetReveal = isActive ? 1 : proximityReveal;
    setRevealRatio((current) => {
      const next = THREE.MathUtils.lerp(current, targetReveal, 1 - Math.exp(-7 * delta));
      return Math.abs(next - current) > 0.004 ? next : current;
    });

    const targetScale = isActive ? 1.18 : 1;
    const nextScale = THREE.MathUtils.lerp(group.current.scale.x, targetScale, 1 - Math.exp(-8 * delta));
    group.current.scale.setScalar(nextScale);
  });

  return (
    <group ref={group} position={parentPos}>
      <mesh
        onPointerOver={() => setHovered(true)}
        onPointerOut={() => setHovered(false)}
        onClick={(event) => { event.stopPropagation(); onSelect(macro); }}
        castShadow
        receiveShadow
      >
        <sphereGeometry args={[0.06, 24, 24]} />
        <meshStandardMaterial
          color={macro.color}
          emissive={macro.color}
          emissiveIntensity={hovered || selected?.id === macro.id ? 2.1 : 1.3}
        />
      </mesh>
      <pointLight color={macro.color} intensity={0.75} distance={0.95} />
      {!compact && <ChildCluster children={children} parentPosition={parentPos} revealRatio={revealRatio} onSelect={onSelect} />}
    </group>
  );
}

function ChildCluster({
  children,
  parentPosition,
  revealRatio,
  onSelect
}: {
  children: KnowledgeNode[];
  parentPosition: THREE.Vector3;
  revealRatio: number;
  onSelect: Props["onSelect"];
}) {
  return (
    <group>
      {children.map((child) => (
        <ChildMicroNode
          key={child.id}
          child={child}
          parentPosition={parentPosition}
          revealRatio={revealRatio}
          onSelect={onSelect}
        />
      ))}
    </group>
  );
}

function ChildMicroNode({
  child,
  parentPosition,
  revealRatio,
  onSelect
}: {
  child: KnowledgeNode;
  parentPosition: THREE.Vector3;
  revealRatio: number;
  onSelect: Props["onSelect"];
}) {
  const [hovered, setHovered] = useState(false);
  const childTarget = useMemo(() => new THREE.Vector3(...child.position), [child.position]);
  const localOffset = useMemo(() => childTarget.clone().sub(parentPosition), [childTarget, parentPosition]);
  const bloomDirection = useMemo(() => localOffset.clone().normalize(), [localOffset]);
  const position = useMemo(() => {
    const clustered = localOffset.clone().multiplyScalar(THREE.MathUtils.lerp(0.28, 1, revealRatio));
    return clustered.add(bloomDirection.clone().multiplyScalar(CHILD_BLOOM_DISTANCE * revealRatio));
  }, [bloomDirection, localOffset, revealRatio]);
  const opacity = THREE.MathUtils.clamp(revealRatio, 0, 1);
  const scale = THREE.MathUtils.lerp(0.01, hovered ? 0.058 : 0.044, revealRatio);

  return (
    <mesh
      position={position}
      scale={scale}
      visible={revealRatio > 0.02}
      onPointerOver={(event) => { event.stopPropagation(); setHovered(true); }}
      onPointerOut={() => setHovered(false)}
      onClick={(event) => { event.stopPropagation(); onSelect(child); }}
    >
      <sphereGeometry args={[1, 12, 12]} />
      <meshStandardMaterial
        color={child.color}
        transparent
        opacity={opacity}
        emissive={child.color}
        emissiveIntensity={(hovered ? 0.9 : 0.55) * revealRatio}
        depthWrite={opacity > 0.6}
      />
    </mesh>
  );
}

function CameraFocus({ node }: { node: KnowledgeNode }) {
  const { camera } = useThree();
  const target = useRef(new THREE.Vector3());
  const destination = useRef(new THREE.Vector3());

  useEffect(() => {
    target.current.copy(new THREE.Vector3(...node.position)).normalize();
    destination.current.copy(target.current).multiplyScalar(1.58);
  }, [node]);

  useFrame((_, delta) => {
    const alpha = 1 - Math.exp(-4.5 * delta);
    camera.position.lerp(destination.current, alpha);
    const desired = new THREE.Matrix4().lookAt(camera.position, target.current, camera.up);
    camera.quaternion.slerp(new THREE.Quaternion().setFromRotationMatrix(desired), alpha);
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.fov = THREE.MathUtils.lerp(camera.fov, 29, alpha);
      camera.updateProjectionMatrix();
    }
  });
  return null;
}

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { billOfMaterials, bomCsv, designators } from './lab/bom';
import CodeEditor from './lab/CodeEditor';
import { COMPILER_URL, compileSketch, compilerHealth, type CompileResult } from './lab/compiler';
import { DEVICES, SHELF, type DeviceKind } from './lab/devices';
import {
  WIRE_COLORS,
  blankProject,
  cloneProject,
  newDevice,
  parseProject,
  sketchOf,
  withSketch,
  type Project,
} from './lab/project';
import { isShareHash, readShareHash, shareHash } from './lab/share';
import { TEMPLATES, type Template } from './lab/templates';
import { useLab } from './lab/useLab';
import Wiring, { RESISTOR_PRESETS, formatOhms, type Selection } from './lab/Wiring';
import { patchJoint } from './mech/edit';
import { Dynamics, loadRapier } from './mech/dynamics';
import { interference, linkFrames, massProperties, type Clash, type MassProps } from './mech/physics';
import { LabMakePanel, LabPartInspector, LabPartsPanel, LabPhysicsPanel, type PhysicsView } from './mech/LabPanel';
import { readTendons } from './mech/tendon';
import { aiPrompt, assemblyFromStl, jointValues, jointsAtStop, shapeSize, validateAssembly, type Assembly } from './mech/assembly';
import { CATALOG, SPEC } from './sim/catalog';
import { parseIntelHex, toIntelHex } from './sim/hex';

const Scene = lazy(() => import('./Scene'));
type Section = import('./Scene').Section;
const STORE_KEY = 'orrery.project.v1';
type Tab = 'wiring' | 'code' | '3d';
type LeftTab = 'build' | 'templates' | 'project';
type RightTab = 'inspect' | 'monitor' | 'physics' | 'make';
const SPEED_OPTIONS = [0.1, 0.2, 0.5, 1, 1.5, 2];

interface Firmware {
  program: Uint16Array;
  /** The code it was built from (null for an uploaded .hex). */
  code: string | null;
  label: string;
}

/** The autosaved bench, else the first template (a share link in the URL is opened after the first render). */
function initialProject(): Project {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved) return parseProject(saved);
  } catch {
    /* storage unavailable or corrupt: start fresh */
  }
  return cloneProject(TEMPLATES[0].project);
}

/** Only devices, their values and the wires matter to the circuit; positions do not. */
function electricalKey(p: Project): string {
  return JSON.stringify([p.devices.map((d) => [d.id, d.kind, d.props]), p.wires.map((w) => [w.a, w.b])]);
}

/** Intel HEX of a program, without the blank flash after its last word. */
function programHex(program: Uint16Array): string {
  let n = program.length;
  while (n > 0 && program[n - 1] === 0) n--;
  return toIntelHex(Array.from(program.subarray(0, n)));
}

async function fetchHex(name: string): Promise<Uint16Array> {
  const res = await fetch(`${import.meta.env.BASE_URL}examples/${name}.hex`);
  const text = res.ok ? await res.text() : '';
  if (!text.trimStart().startsWith(':')) throw new Error(`examples/${name}.hex is missing — run "npm run build:examples".`);
  return parseIntelHex(text);
}

/** Prebuilt firmware for every board of a template. */
async function templateFirmware(t: Template): Promise<Record<string, Firmware>> {
  const entries = Object.entries({ uno: t.hex, ...t.hexes });
  const out: Record<string, Firmware> = {};
  for (const [board, name] of entries) {
    out[board] = { program: await fetchHex(name), code: sketchOf(t.project, board), label: `${t.title} (prebuilt)` };
  }
  return out;
}

function Section({ n, title }: { n: string; title: string }) {
  return (
    <h2 className="section">
      <span className="section-no mono">{n}</span>
      {title}
    </h2>
  );
}

export default function App() {
  const lab = useLab();
  const { sim, snapshot, running, setRunning, speed, setSpeed, realtime, boot: bootSim } = lab;
  const [project, setProject] = useState<Project>(initialProject);
  /** Firmware per board id. */
  const [firmwares, setFirmwares] = useState<Record<string, Firmware>>({});
  const [activeBoard, setActiveBoard] = useState('uno');
  const [tab, setTab] = useState<Tab>('wiring');
  const [selection, setSelection] = useState<Selection>(null);
  const [helper, setHelper] = useState<string | null | undefined>(undefined);
  const [compiling, setCompiling] = useState(false);
  const [result, setResult] = useState<CompileResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [serialIn, setSerialIn] = useState('');
  const [asmDialog, setAsmDialog] = useState(false);
  const [asmText, setAsmText] = useState('');
  const [asmErrors, setAsmErrors] = useState<string[]>([]);
  const [aiRequest, setAiRequest] = useState('a two-finger gripper on one SG90');
  const [labSel, setLabSel] = useState<string | null>(null);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [leftTab, setLeftTab] = useState<LeftTab>('build');
  const [rightTab, setRightTab] = useState<RightTab>('inspect');
  const [fitKey, setFitKey] = useState(0);
  const [showWires, setShowWires] = useState(true);
  const [showTendons, setShowTendons] = useState(true);
  const [section, setSection] = useState<Section>({ on: false, axis: 'z', offset: 0, flip: false });
  /** Mass properties of the current assembly (computed from the printable solids), keyed by its JSON. */
  const massRef = useRef<{ key: string; props: Map<string, MassProps> } | null>(null);
  const [massProps, setMassProps] = useState<Map<string, MassProps> | null>(null);
  const [clashes, setClashes] = useState<Clash[] | null>(null);
  const [checking, setChecking] = useState(false);
  /** Rigid-body dynamics (Rapier) of the mechanism, when switched on. */
  const dynRef = useRef<Dynamics | null>(null);
  const [dynOn, setDynOn] = useState(false);
  const [dynGen, setDynGen] = useState(0);

  /** Hand the mechanism to the simulation, if its masses are known for this exact assembly. */
  const applyMech = useCallback(
    (p: Project) => {
      const s = sim.current;
      if (!s) return;
      const c = massRef.current;
      if (p.assembly && c && c.key === JSON.stringify(p.assembly)) s.setMechanics(p.assembly, c.props);
      else s.setMechanics(undefined, null);
    },
    [sim],
  );
  /** Boot the bench and give it the mechanism's physics. */
  const boot = useCallback(
    (p: Project, programs: Record<string, Uint16Array>) => {
      bootSim(p, programs);
      applyMech(p);
    },
    [bootSim, applyMech],
  );
  const electrical = useRef(electricalKey(project));
  /** Undo/redo history of the whole project (JSON snapshots), recorded 400 ms after the last change. */
  const history = useRef({ past: [] as string[], future: [] as string[], last: JSON.stringify(project), restoring: false });
  const pressStart = useRef(0);

  const refs = useMemo(() => designators(project), [project]);
  const boardIds = project.devices.filter((d) => d.kind === 'uno').map((d) => d.id);
  const hasBoard = boardIds.length > 0;
  const active = boardIds.includes(activeBoard) ? activeBoard : boardIds[0] ?? 'uno';
  const programs = (fw: Record<string, Firmware>) => Object.fromEntries(Object.entries(fw).map(([k, f]) => [k, f.program]));

  // physics: recompute masses when the mechanism changes (debounced while editing)
  useEffect(() => {
    const asm = project.assembly;
    setClashes(null);
    if (!asm) {
      massRef.current = null;
      setMassProps(null);
      sim.current?.setMechanics(undefined, null);
      return;
    }
    const key = JSON.stringify(asm);
    if (massRef.current?.key === key) return;
    let alive = true;
    const timer = setTimeout(() => {
      void massProperties(asm).then((props) => {
        if (!alive) return;
        massRef.current = { key, props };
        setMassProps(props);
        sim.current?.setMechanics(asm, props);
      });
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [project.assembly, sim]);

  // build the dynamics world for the current mechanism (rebuilt when it changes or on reset)
  useEffect(() => {
    const asm = project.assembly;
    if (!dynOn || !asm || !massProps || massRef.current?.key !== JSON.stringify(asm)) {
      dynRef.current?.dispose();
      dynRef.current = null;
      setDynGen((g) => g + 1);
      return;
    }
    let alive = true;
    void loadRapier().then((lib) => {
      if (!alive) return;
      const s = sim.current;
      const start = jointValues(asm, (d) => s?.deviceAngle(d));
      dynRef.current?.dispose();
      dynRef.current = new Dynamics(lib, asm, massProps, start);
      setDynGen((g) => g + 1);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dynOn, massProps, project.assembly]);

  /** Drop a loose PLA ball or cube above the mechanism. */
  const drop = (kind: 'ball' | 'box') => {
    const asm = project.assembly;
    const d = dynRef.current;
    if (!asm || !d) return;
    const frames = linkFrames(asm, new Map());
    let top = 0;
    for (const m of frames.values()) top = Math.max(top, m.elements[13]);
    const [x, , z] = asm.placement ?? [150, 0, 0];
    d.drop(kind, kind === 'ball' ? 30 : 25, [x + 16, top + 80, z + 25]);
  };

  const checkClashes = async () => {
    const asm = project.assembly;
    const s = sim.current;
    if (!asm) return;
    setChecking(true);
    const values = jointValues(asm, (d) => s?.deviceAngle(d));
    setClashes(await interference(asm, values));
    setChecking(false);
  };

  // autosave
  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(project));
    } catch {
      /* private mode: fine */
    }
  }, [project]);

  useEffect(() => {
    void compilerHealth().then(setHelper);
  }, []);

  /** Increments on every bench opened, so a slow firmware fetch for an older one is dropped. */
  const openSeq = useRef(0);
  /**
   * Put a bench on the table and power it: firmware from a share link where it came with one, else the
   * prebuilt firmware when the sketch is an unchanged template.
   */
  const openBench = useCallback(
    async (p: Project, linkFirmware: Record<string, string>) => {
      const seq = ++openSeq.current;
      setProject(p);
      electrical.current = electricalKey(p);
      setSelection(null);
      setResult(null);
      setActiveBoard('uno');
      setFirmwares({});
      boot(p, {});
      const fw: Record<string, Firmware> = {};
      const t = TEMPLATES.find((x) => x.project.code === p.code);
      if (t && p.devices.some((d) => d.kind === 'uno')) {
        try {
          Object.assign(fw, await templateFirmware(t));
        } catch (e) {
          setNotice((e as Error).message);
        }
      }
      for (const [board, hex] of Object.entries(linkFirmware)) {
        try {
          fw[board] = { program: parseIntelHex(hex), code: sketchOf(p, board), label: `${board}: from the link` };
        } catch {
          setNotice(`The link's firmware for ${board} is not valid Intel HEX; compile the sketch to run it.`);
        }
      }
      if (seq !== openSeq.current || !Object.keys(fw).length) return;
      setFirmwares(fw);
      boot(p, programs(fw));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boot],
  );

  /** Open the bench in a share link (#z=… or the older #p=…), then clear the hash so a reload keeps later edits. */
  const openLink = useCallback(
    async (hash: string) => {
      const shared = await readShareHash(hash);
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      if (!shared) return void setNotice('This link does not hold a valid Orrery bench.');
      await openBench(shared.project, shared.firmware);
      setNotice(`Opened "${shared.project.name}" from a link.`);
    },
    [openBench],
  );

  // first run: the bench from the link, else the autosaved one; and any link opened later in this tab
  useEffect(() => {
    if (isShareHash(window.location.hash)) {
      boot(project, {});
      void openLink(window.location.hash);
    } else void openBench(project, {});
    const onHash = () => isShareHash(window.location.hash) && void openLink(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = useCallback(
    (next: Project, isElectrical: boolean) => {
      setProject(next);
      const key = electricalKey(next);
      if (isElectrical && key !== electrical.current) boot(next, programs(firmwares)); // rewiring = power-cycling the bench
      electrical.current = key;
    },
    [firmwares, boot],
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      const h = history.current;
      const cur = JSON.stringify(project);
      if (h.restoring) {
        h.restoring = false;
        h.last = cur;
        return;
      }
      if (cur !== h.last) {
        h.past.push(h.last);
        if (h.past.length > 100) h.past.shift();
        h.future = [];
        h.last = cur;
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [project]);

  const restore = (json: string) => {
    const p = parseProject(json);
    history.current.restoring = true;
    setProject(p);
    electrical.current = electricalKey(p);
    boot(p, programs(firmwares));
  };
  const undo = () => {
    const h = history.current;
    const cur = JSON.stringify(project);
    if (cur !== h.last) (h.past.push(h.last), (h.last = cur));
    const prev = h.past.pop();
    if (!prev) return;
    h.future.push(h.last);
    h.last = prev;
    restore(prev);
  };
  const redo = () => {
    const h = history.current;
    const next = h.future.pop();
    if (!next) return;
    h.past.push(h.last);
    h.last = next;
    restore(next);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) (e.preventDefault(), undo());
      else if (k === 'y' || (k === 'z' && e.shiftKey)) (e.preventDefault(), redo());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const loadTemplate = (t: Template) => {
    setNotice(null);
    void openBench(cloneProject(t.project), {});
  };

  const compileAndRun = async () => {
    setCompiling(true);
    const code = sketchOf(project, active);
    const r = await compileSketch(code);
    setCompiling(false);
    setResult(r);
    setHelper(r.ok || r.diagnostics.length ? 'connected' : await compilerHealth());
    if (r.ok && r.program) {
      const fw = { ...firmwares, [active]: { program: r.program, code, label: `${active}: sketch` } };
      setFirmwares(fw);
      boot(project, programs(fw));
    } else setTab('code');
  };

  /** The first spot on a 20-unit grid, right of the board area, where the new part's outline is clear of others. */
  const freeSpot = (kind: DeviceKind): [number, number] => {
    if (kind === 'uno' && !project.devices.some((d) => overlaps(d, 0, 0, DEVICES.uno.w, DEVICES.uno.h))) return [0, 0];
    const { w, h } = DEVICES[kind];
    for (let row = 0; row < 40; row++)
      for (let col = 0; col < 12; col++) {
        // right of the board when there is one; from the top-left of the default view otherwise
        const x = (hasBoard ? 400 : 0) + col * 20 * 4;
        const y = (hasBoard ? -260 : -180) + row * 20 * 2;
        if (!project.devices.some((d) => overlaps(d, x, y, w, h))) return [x, y];
      }
    return [hasBoard ? 400 : 0, hasBoard ? -260 : -180];
  };

  const addDevice = (kind: DeviceKind) => {
    const [x, y] = freeSpot(kind);
    const d = newDevice(kind, project.devices, x, y);
    update({ ...project, devices: [...project.devices, d] }, true);
    setSelection({ type: 'device', id: d.id });
    setTab('wiring');
  };

  const openFile = async (file: File) => {
    try {
      const text = await file.text();
      if (file.name.endsWith('.hex')) {
        const program = parseIntelHex(text);
        const fw = { ...firmwares, [active]: { program, code: null, label: `${active}: ${file.name}` } };
        setFirmwares(fw);
        boot(project, programs(fw));
      } else {
        const p = parseProject(text);
        setProject(p);
        electrical.current = electricalKey(p);
        setSelection(null);
        boot(p, programs(firmwares));
      }
      setNotice(null);
    } catch (e) {
      setNotice(`Could not open ${file.name}: ${(e as Error).message}`);
    }
  };

  const download = (name: string, data: BlobPart, type: string) => {
    const url = URL.createObjectURL(new Blob([data], { type }));
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    URL.revokeObjectURL(url);
  };

  /** Copy a link to this bench, with the firmware of every board whose sketch it was built from (or an uploaded .hex). */
  const share = async () => {
    const fw: Record<string, string> = {};
    for (const [board, f] of Object.entries(firmwares)) if (f.code === null || f.code === sketchOf(project, board)) fw[board] = programHex(f.program);
    const hash = await shareHash(project, fw);
    const url = `${window.location.origin}${window.location.pathname}${hash}`;
    try {
      await navigator.clipboard.writeText(url);
      setNotice('Share link copied to the clipboard.');
    } catch {
      window.history.replaceState(null, '', hash);
      setNotice('Share link is now in the address bar.');
    }
  };

  const press = (id: string, down: boolean) => {
    const b = sim.current?.buttons.get(id);
    if (!b) return;
    if (down) {
      pressStart.current = performance.now();
      b.press(true);
    } else {
      // a click counts as at least 50 ms so debounced firmware sees it — a UI choice, not a datasheet figure
      b.press(false, Math.max(0.05, ((performance.now() - pressStart.current) / 1000) * speed));
    }
  };

  const removeDevice = (id: string) => {
    if (firmwares[id]) {
      const { [id]: _gone, ...rest } = firmwares;
      setFirmwares(rest);
    }
    update(
      {
        ...project,
        devices: project.devices.filter((d) => d.id !== id),
        wires: project.wires.filter((w) => !w.a.startsWith(`${id}.`) && !w.b.startsWith(`${id}.`)),
      },
      true,
    );
    setSelection(null);
  };

  /** Put a validated assembly on the bench and add any device it mounts that the bench lacks. */
  const installAssembly = (asm: Assembly) => {
    const devices = [...project.devices];
    const added: string[] = [];
    for (const m of asm.mounts ?? []) {
      const existing = devices.find((d) => d.id === m.device);
      if (existing && existing.kind !== m.kind) {
        setNotice(`Cannot import: the bench already has "${m.device}" as a ${existing.kind}, the mechanism mounts a ${m.kind}.`);
        return false;
      }
      if (!existing) {
        const d = newDevice(m.kind, devices, 420 + (added.length % 3) * 170, -260 + Math.floor(added.length / 3) * 100);
        devices.push({ ...d, id: m.device });
        added.push(m.device);
      }
    }
    update({ ...project, devices, assembly: asm }, true);
    setNotice(`Mechanism "${asm.name}" is on the bench${added.length ? `; added ${added.join(', ')} — wire them in FIG. 1` : ''}.`);
    setTab('3d');
    return true;
  };

  const importAssemblyText = (text: string) => {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      setAsmErrors([`not valid JSON: ${(e as Error).message}`]);
      return;
    }
    const r = validateAssembly(json);
    setAsmErrors([...r.errors, ...r.warnings.map((w) => `note: ${w}`)]);
    if (r.ok && r.assembly && installAssembly(r.assembly)) {
      setAsmDialog(false);
      setAsmText('');
    }
  };

  const importMechanismFile = async (file: File) => {
    if (/\.stl$/i.test(file.name)) {
      if (file.size > 4 * 1024 * 1024) return setNotice(`${file.name} is over 4 MB; simplify the mesh first.`);
      const dataUrl = await new Promise<string>((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = () => rej(fr.error);
        fr.readAsDataURL(file);
      });
      const base = file.name.replace(/\.stl$/i, '');
      const cur = project.assembly;
      if (!cur) return void installAssembly(assemblyFromStl(base, dataUrl));
      let n = 1;
      while (cur.links.some((l) => l.id === `part${n}`)) n++;
      const root = cur.links.find((l) => !cur.joints.some((j) => j.child === l.id))!;
      const next: Assembly = {
        ...cur,
        links: [...cur.links, { id: `part${n}`, label: base, shape: { mesh: { data: dataUrl } }, material: 'PLA', make: 'print' }],
        joints: [...cur.joints, { id: `part${n}_fix`, type: 'fixed', parent: root.id, child: `part${n}`, position: [0, 0, 0] }],
      };
      update({ ...project, assembly: next }, true);
      setNotice(`${file.name} added to "${cur.name}" at the root link; export the JSON to set its position.`);
      return;
    }
    setAsmDialog(true);
    setAsmText(await file.text());
    importAssemblyText(await file.text());
  };

  const schemaUrl = `${window.location.origin}${import.meta.env.BASE_URL}schema/orrery-assembly-1.schema.json`;
  const copyPrompt = async () => {
    const example = TEMPLATES.find((t) => t.id === 'robot-arm')!.project.assembly!;
    const text = aiPrompt(aiRequest, schemaUrl, example);
    try {
      await navigator.clipboard.writeText(text);
      setAsmErrors(['prompt copied — paste it into an AI, then paste its JSON answer below']);
    } catch {
      setAsmText(text);
      setAsmErrors(['clipboard unavailable: the prompt is in the box below, copy it from there']);
    }
  };

  const restart = () => boot(project, programs(firmwares));
  const fwLabel = !hasBoard
    ? 'no board'
    : boardIds.length === 1
      ? firmwares[boardIds[0]]?.label ?? 'blank chip'
      : `${boardIds.length} boards · ${boardIds.filter((b) => firmwares[b]).length} programmed`;

  const newBench = () => {
    const p = blankProject();
    setFirmwares({});
    setResult(null);
    setSelection(null);
    setProject(p);
    electrical.current = electricalKey(p);
    boot(p, {});
  };
  const activeFw = firmwares[active];
  const stale = !!activeFw && activeFw.code !== null && activeFw.code !== sketchOf(project, active);
  const selDevice = selection?.type === 'device' ? project.devices.find((d) => d.id === selection.id) : undefined;
  const selWire = selection?.type === 'wire' ? project.wires.find((w) => w.id === selection.id) : undefined;
  const railMa = snapshot?.railMa ?? 0;
  const limit = SPEC.uno.usbFuseMa;
  const gaugeMax = limit * 1.5;
  const asm = project.assembly;
  const stops =
    asm && sim.current && snapshot
      ? jointsAtStop(asm, (d) => sim.current?.servos.get(d)?.angle ?? (asm.mounts?.some((m) => m.device === d && m.kind === 'stepper') ? sim.current?.motorAngle(d) : undefined))
      : [];
  const checks = [
    ...(snapshot?.checks ?? []),
    ...stops.map((j) => ({ level: 'warn' as const, msg: `Joint "${j}" is driven past its limit and sits on its mechanical stop.`, device: undefined as string | undefined })),
    ...(clashes ?? []).map((c) => ({ level: 'error' as const, msg: `Parts "${c.a}" and "${c.b}" collide: ${c.volumeMm3.toFixed(0)} mm³ overlap in this pose.`, device: undefined as string | undefined })),
  ];
  const madeParts = (asm?.links ?? []).filter((l) => l.make && l.make !== 'buy');
  const bom = billOfMaterials(project);
  const instruments = project.devices.filter((d) => d.kind === 'button' || d.kind === 'pot');
  const pinRef = (ref: string) => ref.replace(/^(\w+)\./, (_, id: string) => `${refs[id] ?? id}.`);
  const activeRightTab: RightTab = rightTab === 'physics' && !asm ? 'inspect' : rightTab;
  const onSelectLab = (id: string | null) => {
    setLabSel(id);
    if (id) setRightTab('inspect');
  };
  const onSelectWiring = (s: Selection) => {
    setSelection(s);
    if (s) setRightTab('inspect');
  };

  const setProp = (id: string, props: Record<string, number | string>) =>
    update({ ...project, devices: project.devices.map((d) => (d.id === id ? { ...d, props: { ...d.props, ...props } } : d)) }, true);

  const physicsView: PhysicsView = {
    tendons: () => {
      if (!asm?.tendons?.length) return [];
      const s = sim.current;
      const d = dynRef.current;
      const angle = (dev: string) => s?.deviceAngle(dev);
      const efforts = d?.actuatorEfforts();
      return readTendons(asm, d ? d.frames() : linkFrames(asm, jointValues(asm, angle)), angle, (dev) => (efforts ? efforts.get(dev) : s?.actuatorEffort(dev)));
    },
    massProps,
    actuators: snapshot?.actuators ?? [],
    totalMassG: snapshot?.mechanismMassG ?? null,
    clashes,
    checking,
    onCheck: () => void checkClashes(),
    dynamics: {
      on: dynOn,
      ready: !!dynRef.current,
      setOn: setDynOn,
      reset: () => {
        // switching off disposes the world; switching back on rebuilds it from the current pose
        setDynOn(false);
        setTimeout(() => setDynOn(true), 0);
      },
      drop,
      tracking: () => {
        const s = sim.current;
        return dynRef.current?.tracking((d) => s?.deviceAngle(d)) ?? [];
      },
      touching: () => dynRef.current?.touching() ?? [],
      restOverlaps: () => dynRef.current?.restOverlaps() ?? 0,
    },
  };

  const controlsBlock = instruments.length > 0 && (
    <div className="controls-block">
      <Section n="07" title="Controls" />
      <ul className="parts">
        {instruments.map((d) =>
          d.kind === 'button' ? (
            <li key={d.id}>
              <div className="part-head">
                <span className="ref mono">{refs[d.id]}</span>
                <strong>Push button</strong>
              </div>
              <button
                className="press"
                onPointerDown={() => press(d.id, true)}
                onPointerUp={() => press(d.id, false)}
                onPointerLeave={() => sim.current?.buttons.get(d.id)?.pressed && press(d.id, false)}
              >
                Hold to press
              </button>
            </li>
          ) : (
            <li key={d.id}>
              <div className="part-head">
                <span className="ref mono">{refs[d.id]}</span>
                <strong>Potentiometer</strong>
                <span className="pin mono">wiper {String(snapshot?.devices[d.id]?.wiper ?? '—')} V</span>
              </div>
              <input type="range" min={0} max={1} step={0.01} defaultValue={0.5} onChange={(e) => sim.current?.pots.get(d.id)?.set(Number(e.target.value))} />
            </li>
          ),
        )}
      </ul>
    </div>
  );

  const toggleSection = () => {
    const axisIndex = { x: 0, y: 1, z: 2 }[section.axis];
    const mid = section.axis === 'y' ? 100 : asm?.placement?.[axisIndex] ?? 0;
    setSection({ ...section, on: !section.on, offset: section.on ? section.offset : mid });
  };

  const helperText = helper === undefined ? 'Checking compile helper…' : helper ? 'Compile helper connected' : 'No compile helper — run "npm run compiler"';

  return (
    <div className={`app ${leftOpen ? '' : 'no-left'} ${rightOpen ? '' : 'no-right'}`}>
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="22" height="22">
              <circle cx="16" cy="16" r="3.2" fill="currentColor" />
              <ellipse cx="16" cy="16" rx="13" ry="5" fill="none" stroke="currentColor" strokeWidth="1.2" transform="rotate(-25 16 16)" />
              <circle cx="27" cy="10.8" r="2" fill="currentColor" />
              <path d="M2 16h4M26 16h4M16 2v4M16 26v4" stroke="currentColor" strokeWidth="0.8" />
            </svg>
          </span>
          <strong>Orrery</strong>
          <input className="project-name" value={project.name} onChange={(e) => setProject({ ...project, name: e.target.value })} aria-label="Project name" />
        </div>

        <div className="topbar-controls mono">
          <button
            className="primary compile-btn"
            onClick={() => void compileAndRun()}
            disabled={compiling || !hasBoard}
            title={hasBoard ? `${helperText} · active board: ${active}${stale ? ' (edited)' : ''}` : 'Add an Arduino from the shelf to run a sketch'}
          >
            <span className={`helper-dot ${helper ? 'ok' : 'off'}`} aria-hidden="true" />
            {compiling ? 'Compiling…' : 'Compile & run'}
          </button>
          <button onClick={() => setRunning(!running)} disabled={!sim.current || !!sim.current?.fatal.length}>
            {running ? 'Pause' : 'Run'}
          </button>
          <button onClick={restart} disabled={!sim.current}>
            Reset
          </button>
          <select aria-label="Simulation speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {SPEED_OPTIONS.map((s) => (
              <option key={s} value={s}>
                ×{s.toFixed(1)}
              </option>
            ))}
          </select>
        </div>

        <div className="status mono">
          <span className={`dot ${running ? 'on' : ''}`} title={`${fwLabel}${stale ? ' · edited' : ''}`} />
          <span className="readout">
            <i>T</i>
            {(snapshot?.time ?? 0).toFixed(1)}s
          </span>
          <span className="readout">
            <i>RT</i>
            {(realtime * 100).toFixed(0)}%
          </span>
          {checks.length > 0 && (
            <button
              type="button"
              className="check-pill"
              onClick={() => {
                setRightOpen(true);
                setRightTab('monitor');
              }}
              title="Open Checks & Monitor"
            >
              {checks.length} {checks.length === 1 ? 'issue' : 'issues'}
            </button>
          )}
          <button type="button" className={`panel-toggle ${leftOpen ? 'on' : ''}`} onClick={() => setLeftOpen((o) => !o)} title="Toggle left panel">
            Left
          </button>
          <button type="button" className={`panel-toggle ${rightOpen ? 'on' : ''}`} onClick={() => setRightOpen((o) => !o)} title="Toggle right panel">
            Right
          </button>
        </div>
      </header>

      {leftOpen && (
        <aside className="panel left">
          <nav className="subtabs mono" aria-label="Left panel">
            <button className={leftTab === 'build' ? 'on' : ''} onClick={() => setLeftTab('build')}>
              {tab === '3d' ? 'Parts' : 'Shelf'}
            </button>
            <button className={leftTab === 'templates' ? 'on' : ''} onClick={() => setLeftTab('templates')}>
              Templates
            </button>
            <button className={leftTab === 'project' ? 'on' : ''} onClick={() => setLeftTab('project')}>
              Project
            </button>
          </nav>
          <div className="panel-body">
            {leftTab === 'build' &&
              (tab === '3d' ? (
                <LabPartsPanel
                  project={project}
                  onAssembly={(a) => setProject({ ...project, assembly: a })}
                  selected={labSel}
                  onSelect={onSelectLab}
                  download={download}
                  onImportFile={(f) => void importMechanismFile(f)}
                  onOpenAi={() => {
                    setAsmDialog(true);
                    setAsmErrors([]);
                  }}
                />
              ) : (
                <ul className="shelf">
                  {SHELF.map((k) => {
                    const item = CATALOG[DEVICES[k].catalog];
                    return (
                      <li key={k}>
                        <button onClick={() => addDevice(k)} title={`Add ${DEVICES[k].title}`}>
                          <span className="ref mono">{DEVICES[k].refPrefix}</span>
                          <span className="shelf-name">
                            <strong>{DEVICES[k].title}</strong>
                            <small className="mono">{item.mpn !== '—' ? item.mpn : DEVICES[k].subtitle}</small>
                          </span>
                          <span className="add mono">+</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ))}

            {leftTab === 'templates' && (
              <ul className="examples">
                {TEMPLATES.map((t, i) => (
                  <li key={t.id}>
                    <button onClick={() => void loadTemplate(t)} title={t.summary}>
                      <span className="ex-no mono">TPL-{String(i + 1).padStart(2, '0')}</span>
                      <strong>{t.title}</strong>
                      <span>{t.summary}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {leftTab === 'project' && (
              <div className="lab-stack">
                <Section n="01" title="Files" />
                <div className="file-row">
                  <button onClick={newBench}>New</button>
                  <button onClick={undo} title="Undo (Ctrl+Z)">Undo</button>
                  <button onClick={redo} title="Redo (Ctrl+Y)">Redo</button>
                  <label className="file-btn">
                    Open
                    <input type="file" accept=".json,.hex" onChange={(e) => e.target.files?.[0] && void openFile(e.target.files[0])} />
                  </label>
                  <button onClick={() => download(`${project.name.replace(/[^\w-]+/g, '_') || 'bench'}.orrery.json`, JSON.stringify(project, null, 2), 'application/json')}>Save</button>
                  <button onClick={() => void share()}>Share</button>
                </div>
                <p className="muted small">Open takes .json or .hex. Projects autosave in this browser.</p>
                {notice && <p className="notice small">{notice}</p>}

                <Section n="02" title="Firmware" />
                <p className="mono small">
                  {fwLabel}
                  {stale && <span className="warn-text"> · edited</span>}
                </p>
                <p className={`helper mono ${helper ? 'ok' : 'off'}`}>
                  {helper === undefined ? 'checking compile helper…' : helper ? '● compile helper connected' : '○ no compile helper — run "npm run compiler"'}
                </p>
                <p className="muted small mono">{COMPILER_URL}</p>

                <Section n="03" title="Mechanism" />
                {asm ? (
                  <div className="card mech">
                    <strong>{asm.name}</strong>
                    <span className="mono muted small">
                      {asm.links.length} links · {asm.joints.length} joints · {(asm.mounts ?? []).length} mounted
                    </span>
                  </div>
                ) : (
                  <p className="muted small">No mechanism yet. Import an Orrery Assembly (.json), an STL, or ask an AI.</p>
                )}
                <div className="file-row">
                  <label className="file-btn">
                    Import
                    <input type="file" accept=".json,.stl" onChange={(e) => e.target.files?.[0] && void importMechanismFile(e.target.files[0])} />
                  </label>
                  <button onClick={() => { setAsmDialog(true); setAsmErrors([]); }}>AI / paste</button>
                  <button disabled={!asm} onClick={() => asm && download(`${asm.name.replace(/[^\w-]+/g, '_')}.assembly.json`, JSON.stringify(asm, null, 2), 'application/json')}>Export</button>
                  <button disabled={!asm} onClick={() => { update({ ...project, assembly: undefined }, true); setLabSel(null); }}>Remove</button>
                </div>
                <p className="muted small">
                  <a href="https://github.com/dinhgia2106/orrery/blob/main/docs/assembly-format.md" target="_blank" rel="noreferrer">Assembly v1</a> ·{' '}
                  <a href={schemaUrl} target="_blank" rel="noreferrer">JSON Schema</a>
                </p>
              </div>
            )}
          </div>
        </aside>
      )}

      <main className="stage">
        <nav className="tabs mono">
          {(['wiring', 'code', '3d'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t === 'wiring' ? 'FIG. 1 — WIRING' : t === 'code' ? 'SKETCH.INO' : 'FIG. 2 — 3D LAB'}
              {t === 'code' && stale && <span className="badge">edited</span>}
              {t === 'code' && result && !result.ok && <span className="badge err">errors</span>}
            </button>
          ))}
        </nav>
        <div className="tab-body">
          {tab === 'wiring' && (
            <>
              <Wiring project={project} onChange={update} selection={selection} onSelect={onSelectWiring} snapshot={snapshot} refs={refs} onPress={press} />
              {project.devices.length === 0 && (
                <div className="empty-bench">
                  <strong>The bench is empty</strong>
                  <span>Add parts from the shelf on the left, or load a template — try <em>Five-finger robot hand</em>.</span>
                  <span>
                    The 3D prototype is in{' '}
                    <button className="link-btn" onClick={() => setTab('3d')}>
                      FIG. 2 — 3D LAB
                    </button>
                    . Deleted something by accident? <button className="link-btn" onClick={undo}>Undo</button> (Ctrl+Z).
                  </span>
                </div>
              )}
              <div className="overlay" aria-hidden="true">
                <span className="crop tl" />
                <span className="crop tr" />
                <span className="crop bl" />
                <span className="crop br" />
                <div className="fig bottom mono">
                  click a pin, then another pin, to run a wire
                  <small>drag parts · drag the background to pan · wheel to zoom · Delete removes the selection</small>
                </div>
                <TitleBlock project={project} firmware={fwLabel} />
              </div>
            </>
          )}
          {tab === 'code' && (
            <div className="code-pane">
              {boardIds.length > 1 && <BoardTabs ids={boardIds} active={active} onPick={setActiveBoard} refs={refs} programmed={firmwares} />}
              <CodeEditor code={sketchOf(project, active)} onChange={(code) => setProject(withSketch(project, active, code))} onCompile={() => void compileAndRun()} diagnostics={result?.diagnostics ?? []} />
              {result && <pre className={`compile-log mono ${result.ok ? 'ok' : 'err'}`}>{result.log || (result.ok ? 'Compiled.' : 'Failed.')}</pre>}
            </div>
          )}
          {tab === '3d' && (
            <>
              <Suspense fallback={<div className="loading mono">LOADING 3D SCENE…</div>}>
                <Scene
                  key={`scene-${dynGen}`}
                  sim={sim}
                  project={project}
                  section={section}
                  dyn={dynRef}
                  fitKey={fitKey}
                  showWires={showWires}
                  showTendons={showTendons}
                  lab={{
                    selected: labSel,
                    onSelect: onSelectLab,
                    onMoveJoint: (id, position) => project.assembly && setProject({ ...project, assembly: patchJoint(project.assembly, id, { position }) }),
                    onMovePlacement: (placement) => project.assembly && setProject({ ...project, assembly: { ...project.assembly, placement } }),
                    clashing: new Set((clashes ?? []).flatMap((c) => [c.a, c.b])),
                  }}
                />
              </Suspense>
              <div className="scene-toolbar mono">
                <button type="button" onClick={() => setFitKey((k) => k + 1)} title="Frame the whole bench">
                  Fit
                </button>
                {project.wires.length > 0 && (
                  <button type="button" className={showWires ? 'on' : ''} onClick={() => setShowWires((w) => !w)} title="Toggle jumper wires">
                    Wires
                  </button>
                )}
                {(asm?.tendons?.length ?? 0) > 0 && (
                  <button type="button" className={showTendons ? 'on' : ''} onClick={() => setShowTendons((t) => !t)} title="Toggle tendon lines">
                    Tendons
                  </button>
                )}
                <button type="button" className={section.on ? 'on' : ''} onClick={toggleSection} title="Cut the 3D bench with a section plane">
                  Section
                </button>
              </div>
              {section.on && <SectionPanel section={section} onChange={setSection} center={asm?.placement} />}
              <div className="overlay" aria-hidden="true">
                <span className="crop tl" />
                <span className="crop tr" />
                <span className="crop bl" />
                <span className="crop br" />
                <div className="grid-note mono">
                  <span className="grid-swatch" /> GRID 10 mm · wheel zoom · right-drag pan · double-click focus
                </div>
              </div>
            </>
          )}
        </div>
      </main>

      {rightOpen && (
        <aside className="panel right">
          <nav className="subtabs mono" aria-label="Right panel">
            <button className={activeRightTab === 'inspect' ? 'on' : ''} onClick={() => setRightTab('inspect')}>
              Inspect
            </button>
            <button className={activeRightTab === 'monitor' ? 'on' : ''} onClick={() => setRightTab('monitor')}>
              Monitor
              {checks.length > 0 && <span className="badge err">{checks.length}</span>}
            </button>
            {asm && (
              <button className={activeRightTab === 'physics' ? 'on' : ''} onClick={() => setRightTab('physics')}>
                Physics
              </button>
            )}
            <button className={activeRightTab === 'make' ? 'on' : ''} onClick={() => setRightTab('make')}>
              {asm ? 'Make' : 'BOM'}
            </button>
          </nav>

          <div className="panel-body">
            {activeRightTab === 'inspect' && (
              <div className="lab-stack">
                {tab === '3d' ? (
                  <LabPartInspector
                    project={project}
                    onAssembly={(a) => setProject({ ...project, assembly: a })}
                    selected={labSel}
                    onSelect={onSelectLab}
                    download={download}
                    massProps={massProps}
                    totalMassG={snapshot?.mechanismMassG ?? null}
                  />
                ) : selDevice ? (
                  <div className="card inspector">
                    <div className="part-head">
                      <span className="ref mono">{refs[selDevice.id]}</span>
                      <strong>{DEVICES[selDevice.kind].title}</strong>
                      <span className="pin mono">{DEVICES[selDevice.kind].subtitle}</span>
                    </div>
                    {selDevice.kind === 'resistor' && (
                      <label className="field mono">
                        <span>VALUE</span>
                        <select value={selDevice.props.ohms ?? 220} onChange={(e) => setProp(selDevice.id, { ohms: Number(e.target.value) })}>
                          {RESISTOR_PRESETS.map((o) => (
                            <option key={o} value={o}>
                              {formatOhms(o)}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {selDevice.kind === 'psu' && (
                      <label className="field mono">
                        <span>OUTPUT V</span>
                        <input type="number" min={0} max={35} step={0.1} value={selDevice.props.volts ?? 12} onChange={(e) => setProp(selDevice.id, { volts: Math.min(35, Math.max(0, Number(e.target.value))) })} />
                      </label>
                    )}
                    {selDevice.kind === 'cap' && (
                      <label className="field mono">
                        <span>µF</span>
                        <input type="number" min={1} max={10000} step={1} value={selDevice.props.uf ?? 100} onChange={(e) => setProp(selDevice.id, { uf: Math.max(1, Number(e.target.value)) })} />
                      </label>
                    )}
                    <StateList state={snapshot?.devices[selDevice.id]} />
                    {selDevice.kind === 'uno' && <p className="muted small">Hover a header pin in the wiring view to see its mode and voltage.</p>}
                    <button className="danger" onClick={() => removeDevice(selDevice.id)}>
                      Remove {refs[selDevice.id]}
                    </button>
                  </div>
                ) : selWire ? (
                  <div className="card inspector">
                    <div className="part-head">
                      <span className="ref mono">W</span>
                      <strong className="mono">
                        {pinRef(selWire.a)} → {pinRef(selWire.b)}
                      </strong>
                    </div>
                    <div className="swatches">
                      {WIRE_COLORS.map((c) => (
                        <button
                          key={c}
                          style={{ background: c }}
                          className={c === selWire.color ? 'on' : ''}
                          onClick={() => setProject({ ...project, wires: project.wires.map((w) => (w.id === selWire.id ? { ...w, color: c } : w)) })}
                          aria-label={`colour ${c}`}
                        />
                      ))}
                    </div>
                    <button
                      className="danger"
                      onClick={() => {
                        update({ ...project, wires: project.wires.filter((w) => w.id !== selWire.id) }, true);
                        setSelection(null);
                      }}
                    >
                      Remove wire
                    </button>
                  </div>
                ) : (
                  <p className="muted small">
                    {project.devices.length === 0
                      ? 'The bench is empty. Add parts from the shelf and wire them pin to pin.'
                      : 'Select a part or wire to inspect it.'}
                  </p>
                )}
                {controlsBlock}
              </div>
            )}

            {activeRightTab === 'monitor' && (
              <div className="lab-stack">
                <Section n="01" title="Checks" />
                {checks.length ? (
                  <ul className="warnings">
                    {checks.map((c, i) => (
                      <li
                        key={i}
                        className={c.level}
                        onClick={() => {
                          if (!c.device) return;
                          setSelection({ type: 'device', id: c.device });
                          setTab('wiring');
                          setRightTab('inspect');
                        }}
                      >
                        {c.device && <b className="mono">{refs[c.device]} </b>}
                        {c.msg}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="ok mono">{snapshot ? '✓ NO PROBLEMS DETECTED' : 'not running'}</p>
                )}

                <Section n="02" title="Power · 5 V rail" />
                {!hasBoard && <p className="muted small">No board on the bench: bench supplies power the circuit directly.</p>}
                {hasBoard && (
                  <>
                    <div className={`gauge ${railMa > limit ? 'over' : ''}`}>
                      <div className="gauge-bar">
                        <span className="gauge-fill" style={{ width: `${Math.min(100, (railMa / gaugeMax) * 100)}%` }} />
                        <span className="gauge-limit" style={{ left: `${(limit / gaugeMax) * 100}%` }} />
                      </div>
                      <div className="gauge-scale mono">
                        <span>0</span>
                        <span style={{ left: `${(limit / gaugeMax) * 100}%` }}>{limit} mA fuse</span>
                      </div>
                      <p className="mono gauge-read">
                        peak <b>~{railMa} mA</b>
                      </p>
                    </div>
                    <p className="muted small">Uno &amp; servo currents are approximations.</p>
                  </>
                )}

                <Section n="03" title="Serial monitor" />
                {boardIds.length > 1 && <BoardTabs ids={boardIds} active={active} onPick={setActiveBoard} refs={refs} programmed={firmwares} />}
                <pre className="serial">{snapshot?.serial[active] || '—'}</pre>
                <form
                  className="serial-in"
                  onSubmit={(e) => {
                    e.preventDefault();
                    sim.current?.sendSerial(`${serialIn}\n`, active);
                    setSerialIn('');
                  }}
                >
                  <input className="mono" value={serialIn} onChange={(e) => setSerialIn(e.target.value)} placeholder="send to Serial (newline added)" />
                  <button type="submit">Send</button>
                </form>

                {controlsBlock}
              </div>
            )}

            {activeRightTab === 'physics' && asm && <LabPhysicsPanel physics={physicsView} asm={asm} onSelect={onSelectLab} />}

            {activeRightTab === 'make' && (
              <div className="lab-stack">
                {asm && <LabMakePanel project={project} asm={asm} download={download} />}
                <Section n={asm ? '02' : '01'} title="Bill of materials" />
                <ul className="bom">
                  {bom.map((l) => (
                    <li key={l.item.key}>
                      <div className="part-head">
                        <span className="ref mono">{l.refs.join(', ')}</span>
                        <strong>{l.item.name}</strong>
                        <span className="pin mono">QTY {l.qty}</span>
                      </div>
                      <div className="mono">
                        {l.item.manufacturer} <b className="mpn">{l.item.mpn}</b>
                      </div>
                      {l.values.length > 0 && <div className="bom-specs mono">{l.values.join(' · ')}</div>}
                      <div className="bom-specs muted">{l.item.specs.join(' · ')}</div>
                      {l.item.notes?.map((n) => (
                        <div key={n} className="bom-note">
                          {n}
                        </div>
                      ))}
                      <div className="bom-links">
                        <a href={l.item.url} target="_blank" rel="noreferrer">
                          Product page
                        </a>
                        <a href={l.item.datasheet.url} target="_blank" rel="noreferrer">
                          Datasheet
                        </a>
                      </div>
                    </li>
                  ))}
                </ul>
                {asm && (madeParts.length > 0 || (asm.hardware ?? []).length > 0) && (
                  <div className="card mech-bom">
                    <div className="part-head">
                      <span className="ref mono">MECH</span>
                      <strong>{asm.name}</strong>
                    </div>
                    {madeParts.length > 0 && (
                      <table className="mono small">
                        <tbody>
                          {madeParts.map((l) => {
                            const [x, y, z] = shapeSize(l.shape);
                            return (
                              <tr key={l.id}>
                                <td>{l.make}</td>
                                <td>{l.label ?? l.id}</td>
                                <td>{l.material ?? '—'}</td>
                                <td>{'mesh' in l.shape ? 'STL' : `${Math.round(x)}×${Math.round(y)}×${Math.round(z)}`}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                    {(asm.hardware ?? []).map((h) => (
                      <div key={h.item} className="small">
                        <b className="mono">{h.qty}×</b> {h.item}
                        {h.note && <span className="muted"> — {h.note}</span>}
                      </div>
                    ))}
                  </div>
                )}
                <p className="muted small">Not listed: jumper wires, breadboard.</p>
                <button className="press" onClick={() => download('orrery-bom.csv', bomCsv(bom), 'text/csv')}>
                  Export BOM (.csv)
                </button>
              </div>
            )}
          </div>
        </aside>
      )}

      {asmDialog && (
        <div className="modal-back" onClick={() => setAsmDialog(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Import a mechanism">
            <div className="modal-head">
              <strong>Mechanism — ask an AI or paste JSON</strong>
              <button onClick={() => setAsmDialog(false)} aria-label="Close">×</button>
            </div>
            <label className="field-col small">
              <span className="mono">1 · DESCRIBE IT</span>
              <input value={aiRequest} onChange={(e) => setAiRequest(e.target.value)} placeholder="e.g. a pan-tilt camera mount on two SG90s" />
            </label>
            <button onClick={() => void copyPrompt()}>Copy prompt for any AI (rules + example + schema)</button>
            <label className="field-col small">
              <span className="mono">2 · PASTE THE ORRERY ASSEMBLY JSON</span>
              <textarea className="mono" rows={12} value={asmText} onChange={(e) => setAsmText(e.target.value)} spellCheck={false} placeholder='{ "format": "orrery.assembly", "version": 1, ... }' />
            </label>
            {asmErrors.length > 0 && (
              <ul className="asm-errors mono small">
                {asmErrors.map((e, i) => (
                  <li key={i} className={e.startsWith('note:') || e.startsWith('prompt') || e.startsWith('clipboard') ? 'note' : ''}>
                    {e}
                  </li>
                ))}
              </ul>
            )}
            <button className="primary" onClick={() => importAssemblyText(asmText)} disabled={!asmText.trim()}>
              Validate &amp; put on the bench
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Whether a part placed at (x, y) with size w × h would touch device d (with room for labels and pins). */
function overlaps(d: { kind: DeviceKind; x: number; y: number }, x: number, y: number, w: number, h: number): boolean {
  const m = 30;
  const def = DEVICES[d.kind];
  return x < d.x + def.w + m && x + w + m > d.x && y < d.y + def.h + m && y + h + m > d.y;
}

/** Cut the 3D bench with a plane to look inside parts: pockets, holes, tendon channels, mounted servos. */
function SectionPanel({ section, onChange, center }: { section: Section; onChange: (s: Section) => void; center?: [number, number, number] }) {
  const axisIndex = { x: 0, y: 1, z: 2 }[section.axis];
  const mid = section.axis === 'y' ? 100 : center?.[axisIndex] ?? 0;
  const set = (patch: Partial<Section>) => onChange({ ...section, ...patch });
  return (
    <div className="section-panel mono">
      <div className="lab-row">
        {(['x', 'y', 'z'] as const).map((a) => (
          <button key={a} className={section.axis === a ? 'on' : ''} onClick={() => set({ axis: a, offset: a === 'y' ? 100 : center?.[{ x: 0, y: 1, z: 2 }[a]] ?? 0 })}>
            {a.toUpperCase()}
          </button>
        ))}
        <button onClick={() => set({ flip: !section.flip })}>flip</button>
      </div>
      <input type="range" min={mid - 300} max={mid + 300} step={1} value={section.offset} onChange={(e) => set({ offset: Number(e.target.value) })} />
      <span>
        {section.axis.toUpperCase()} = {section.offset} mm
      </span>
    </div>
  );
}

function BoardTabs({ ids, active, onPick, refs, programmed }: { ids: string[]; active: string; onPick: (id: string) => void; refs: Record<string, string>; programmed: Record<string, unknown> }) {
  return (
    <div className="board-tabs mono">
      {ids.map((id) => (
        <button key={id} className={id === active ? 'on' : ''} onClick={() => onPick(id)}>
          {refs[id]} · {id}
          {!programmed[id] && <span className="muted"> (blank)</span>}
        </button>
      ))}
    </div>
  );
}

function StateList({ state }: { state?: Record<string, number | boolean | string> }) {
  if (!state) return null;
  return (
    <dl className="part-state mono">
      {Object.entries(state).map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function TitleBlock({ project, firmware }: { project: Project; firmware?: string }) {
  return (
    <table className="titleblock mono">
      <tbody>
        <tr>
          <th>PROJECT</th>
          <td colSpan={3}>{project.name}</td>
        </tr>
        <tr>
          <th>FIRMWARE</th>
          <td colSpan={3}>{firmware ?? '—'}</td>
        </tr>
        <tr>
          <th>PARTS</th>
          <td>{project.devices.length}</td>
          <th>WIRES</th>
          <td>{project.wires.length}</td>
        </tr>
      </tbody>
    </table>
  );
}

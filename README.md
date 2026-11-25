# Orrery

**Build robots and IoT devices in the browser before you build them for real.**

An orrery is a clockwork model that reproduces the motion of the real thing. Orrery does that for hardware. It is a **custom lab**: the bench gives you real parts with real pins, you wire them pin to pin, write the sketch, and Orrery runs the **compiled Arduino firmware** cycle by cycle against the circuit you built. Wiring mistakes, power problems and timing bugs show up on screen instead of on the bench.

**Live:** https://dinhgia2106.github.io/orrery/

## The lab

1. **Device shelf** — the bench starts empty and takes any number of parts: Arduino UNO R3 boards (each with its own sketch; wire one board's TX/D1 to another's RX/D0 and they talk over serial), micro servo, A4988 driver, NEMA 17 stepper, tactile switch, potentiometer, LED, resistor, electrolytic capacitor and bench supply. Every part has its real pins: the Uno's full headers (D0–D13, A0–A5, 5V, 3V3, VIN, three GND, SDA/SCL = A4/A5), the A4988 carrier's 16 pins (EN, MS1–3, RST, SLP, STEP, DIR, VMOT, GND, 1A/1B/2A/2B, VDD), the B3F's four legs (1–2 and 3–4 are the same contact).
2. **Wiring** (FIG. 1) — click a pin, then another pin, to run a jumper wire. Drag parts, pan, zoom; hover a Uno pin to see its mode and voltage; select a wire to recolour or delete it.
3. **Sketch** — write Arduino C++ in the editor and press **Compile & run** (Ctrl+Enter). Errors are marked on their lines.
4. **Run** — with no board the circuit still runs from bench supplies (an LED, a divider, a motor driver's power side); a board with nothing uploaded is a blank chip with every pin an input. With a sketch, the firmware runs on an emulated ATmega328P; the bench circuit is solved from your wiring (DC nodal analysis) every time an output pin changes, so inputs see real voltages: pull-ups, dividers, an open button, a floating pin.
5. **3D bench** (FIG. 2) — the same project at real scale, laid out like your wiring view. The wheel zooms towards the cursor, right-drag pans, double-clicking a part flies the camera to it, *fit view* frames the whole bench again. Wires end at the real connector (an SG90's 3-way plug, a header pin) and follow parts mounted on moving links; each wire glows with its net's voltage (full at 5 V), and while a board pin keeps switching a net (servo pulses, PWM, serial) marks run along the wire away from that pin — they show activity, not signal speed.

Projects autosave in the browser, save/open as `.orrery.json`, and **Share** puts the whole project in a link (compressed, `#z=…`), together with the firmware each board is running when it was built from the current sketch or uploaded as a `.hex` — so the link runs on any machine without a compiler. Opening a link replaces the bench on the table; the hash is then cleared, so a reload keeps your later edits. Seven templates (Blink, Servo sweep, Stepper + A4988, Two-joint robot arm, Five-finger robot hand, Dexterous hand with 17 DOF on two boards, Two boards over serial) come wired and with prebuilt firmware, so they run even without a compiler.

### Mechanisms: the Orrery Assembly Format

3D mechanisms are JSON files in the **[Orrery Assembly Format](docs/assembly-format.md)** ([JSON Schema](public/schema/orrery-assembly-1.schema.json)): rigid *links* (box, cylinder, capsule, sphere or your STL, with material and how each is made), *joints* that join them into a tree (revolute, prismatic, fixed, with axis and limits) driven by a bench servo or stepper or *following* another joint by a ratio (tendons, gears), *mounts* that build bench devices into a link, and a *hardware* list. It is URDF's model in millimetres and degrees, bound to the bench.

- **Import** an assembly or an STL; devices it mounts that the bench lacks are added, ready to wire.
- **Ask an AI**: the lab copies a prompt with the rules, an example and the schema; paste the answer back and the validator lists every problem in plain words.
- The 3D view moves the joints from the running firmware; a drive pushing a joint past its limit is reported; printed parts and hardware join the BOM.
- **Hinges and tendons are real parts.** A joint can name the screw it turns on (`axle`: M2/M3 and length, drawn with its ISO 4762 head and ISO 4032 nut, visible in section views). *Tendons* are lines from a printed two-groove spool on a servo or stepper shaft, through PTFE sheaths (constant length inside, like a Bowden cable) and eyelets, wrapping the round end of the joints they cross, to an anchor. Orrery measures every line's routed length each frame and compares it with what the spool has reeled in — **slack** or **stretch** is a real check of the design — and shades the line by its **tension** (grey → amber → red at stall): the actuator's torque share for the gravity and contact loads it holds, divided by the spool radius. Marks on the line are fixed to it, so they slide through the guides as it moves.
- Example — a dexterous hand: [`examples/dexterous-hand/dexterous-hand.assembly.json`](examples/dexterous-hand/dexterous-hand.assembly.json) has 17 driven joints (wrist rotation and pitch; per finger spread, knuckle and middle flex with the tip following; thumb opposition, base and middle flex). Fingers are clevis hinges (fork, tongue, M2 axle) with eyelets; 15 SG90s in a printed bed each carry a spool reeling a flexor and an extensor (30 lines) through sheaths into the palm; the wrist servos drive their parts directly. Spool radii were fitted so the spool takes up what the joints take up: over each servo's range every line stays within about 1 mm of taut, and flexing one joint pulls the lines of the next by under 2 mm (they cross it beside its pin) — the lab shows these numbers live. U1 runs the flexion servos and sends the pose to U2 over serial, U2 the spread and wrist (the Servo library drives at most 12 servos per Uno). The sketches ease every servo through 18 poses — open, fist, point, peace, spread, OK, wave, *knuckles* (first segments only), *hook* (outer segments only), three, four, rock, thumbs up, call me, pinch, gun, grasp and a *piano* tap where the fingers bend one after another — because each knuckle and middle joint has its own servo.
- Example — what a robot hand needs: [`examples/robot-hand/robot-hand.assembly.json`](examples/robot-hand/robot-hand.assembly.json) (forearm with five SG90s and their spools, wrist, palm with hinge tabs, 14 phalanges on M2 axles, one flexor through all three joints of a finger and one extensor over their backs, sheaths, a wrist bearing).

### 3D lab: from prototype to parts you can make

The 3D tab is a lab, not just a view: start a mechanism, add parts (box, cylinder, capsule, sphere, or your STL), set their sizes in millimetres, join them with fixed, revolute or prismatic joints, drive joints from the bench's servos and steppers, and drag a part's joint with the gizmo. **Features** make printed parts real: holes (M3 3.4 mm, M2 2.4 mm — ISO 273 medium), cuts, bosses, and pockets that fit the real parts — SG90 body, NEMA 17 face (φ22 pilot and 4 × M3 on 31 mm, from the SY42STH38-1684A drawing), A4988 carrier, B3F switch. Parts are built as watertight solids with [manifold](https://github.com/elalish/manifold) and shown exactly as they will print.

**Section view**: cut the whole bench with a plane along X, Y or Z (slider, flip) to look inside — pockets, hinge holes, tendon channels and the servos seated in them; cut faces are drawn in red.

**3D print**: *Make it → 3D print* plans every printed part for a slicer: it tries the six ways the part can lie and keeps the one needing least support (or the one you pick), turns it Z up, centres it and sets it on the bed, and lists its size, volume and solid filament mass (sourced densities; infill makes it lighter). Faces leaning more than 45° from vertical, facing down, get support columns (1.2 mm square every 2.5 mm, 0.2 mm gap to the part — rules of thumb you can change, not printer data); a preview shows the part and its supports on your bed size, and parts that do not fit are flagged. A uniform **scale** shrinks or grows everything (Orrery warns that scaled holes and pockets no longer fit real screws and servos). Download one part (STL with its supports) or **Print files (ZIP)**: `print/<part>.stl`, `print/<part>-supports.stl` and `print.csv` with every size and mass.

**Make it**: each part exports as a binary STL (mm) and an A4 drawing (three views, third-angle projection, overall sizes, feature list, title block); **Fabrication package** puts every part's STL and drawing, the BOM (electronics with part numbers, made parts, hardware), the assembly JSON and a README in one ZIP. Pocket clearance (0.2 mm per side by default) is a printing allowance, not a datasheet value — print a test piece.

### What the physics covers

The mechanism is simulated with **statics under gravity**, computed from the real geometry:

- **Mass and centre of mass** of every made part are integrated from its watertight solid (volume × density): PLA 1.24, PETG 1.27 g/cm³ (Prusament data sheets, ISO 1183), ABS 1.04 (Essentium ABS MG94, ISO 1183), aluminium 6061-T6 2.70 (ASM/MatWeb, Aalco). Parts print solid in this model (an upper bound — set `massG` for infilled or hollow parts, meshes, and materials without a sourced density). Mounted parts add their own mass: SG90 9 g, NEMA 17 285 g, A4988 carrier 1.3 g.
- **Tendon tension and slack**: see *Hinges and tendons* above. In the dynamics the actuator's share is quasi-static: at each joint it holds everything beyond it against gravity and the contact forces Rapier's solver reports (a finger pressing on a ball tensions its flexor); inertial torques while accelerating are left out.
- **Gravity torque at every revolute joint** in the current pose, carried back through followers (tendons, gears) and transmissions to each servo or stepper by virtual work (ideal, friction-free).
- **Actuators feel it**: an SG90 follows the straight torque–speed line between its no-load speed (60°/0.1 s) and stall torque (1.8 kgf·cm), so it slows under load and stalls at 1.8 kgf·cm; a NEMA 17 loses steps above its 3.7 kgf·cm holding torque. Loads, % of limit and stalls show in the 3D lab and the checks.
- **Collisions**: *Check collisions in this pose* intersects every pair of made parts (parts joined directly by a joint are skipped) and reports the overlap in mm³; clashing parts turn red.

- **Dynamics (Rapier)**: switch on *Dynamics* in the 3D lab and every part becomes a rigid body with its real mass and the inertia of its shape, under standard gravity (9.80665 m/s²). Joints are driven by motors whose torque is limited to the SG90 stall torque or the NEMA 17 holding torque through each transmission (tendon followers track their source joint's real angle), so an overloaded joint sags or swings instead of holding; commanded vs reached joint angles show where the mechanism cannot keep up. Verified against a physical pendulum: a 100 mm bar swings with the period 2π√(I/(m·g·d)) within 2 %.
- **Contacts while moving**: parts collide with each other, the bench and loose objects you drop (a 30 mm PLA ball or a 25 mm cube), using each part's primitive shape (holes and pockets are not in the collision shape). A finger closing into the palm stops there and its joint shows the lag; parts in contact turn red and are listed. Parts joined by a hinge never collide with each other, and pairs that already overlap in the home pose (a pin in a knuckle, a servo seated in its pocket) are treated as designed and left out. Parts on a fixed joint are one rigid body with their parent.
- **Numerical conditioning** (a solver setting, not physics): every moving part gets at least 1·10⁻⁵ kg·m² of rotational inertia, so a light link between heavy ones (a 2 g knuckle between a 266 g palm and a finger) does not make Rapier's iterative joint solver give way. Masses and gravity loads are unchanged; very light parts react more slowly to impacts than real ones would.

Not modelled: friction values (Rapier's default 0.5, not measured), tendon stretch and friction in sheaths and eyelets (lines are inextensible and frictionless; joints follow their drives, so a line asked to stretch is reported, not simulated), bending or breaking of parts, shaft side loads, and prismatic joints in the dynamics (held fixed). The joint motors' position gain is a control choice, not a datasheet value.

### Compiling your sketch

The page cannot compile C++ by itself, so a small helper runs on your machine and uses your own `arduino-cli`:

```bash
arduino-cli core install arduino:avr
arduino-cli lib install Servo      # and any other library your sketch includes
npm run compiler                   # http://127.0.0.1:7337, used by the dev server and the live site
```

It listens on 127.0.0.1 only, accepts requests only from the Orrery pages (localhost dev/preview and the GitHub Pages site), refuses `#include` of file paths and `.incbin`, and hides your home folder in logs. Without the helper you can still run the templates or open a `.hex` built elsewhere.

### What the bench checks

| Mistake | What you see |
|---|---|
| 5V shorted to GND, a supply back-feeding the Uno | the circuit is not solved; "Short circuit" |
| Input pin wired to an open contact without `INPUT_PULLUP` or a pull-down | "floats and reads at random" (ATmega328P VIL/VIH 0.3/0.6 VCC) |
| LED without a resistor / output pin into a low resistance | over-current against the WP7113ID's 30 mA and the ATmega328P's 40 mA per pin |
| LED in backwards | "reverse-biased — it will not light" |
| Button wired across one contact pair | "only one contact pair is wired" |
| Servo powered from another supply without a common ground | the servo ignores its signal |
| A4988 RST floating, SLP low, EN high, no VMOT, VDD missing | the driver ignores STEP and says why |
| Motor coils split across 1A/2A | "motor buzzes instead of turning"; one coil reversed turns the motor backwards |
| No ≥ 47 µF capacitor on VMOT (Pololu recommendation), electrolytic reversed | warning |
| Servo current on the Uno's 5 V | rail total against the 500 mA USB polyfuse |
| Servo driven by `analogWrite()`, STEP pulses shorter than 1 µs, DIR set < 200 ns before STEP, steps faster than the motor follows | warning; lost steps |
| Button bounce (B3F ≤ 5 ms) | firmware that does not debounce counts several presses |

### Headless runs

`runProject(project, options)` in `src/headless/run.ts` runs a project with no browser and returns one JSON report. Scripts, tests and the MCP server (below) use it to judge a design without the 3D view.

```ts
const report = await runProject(project, {
  seconds: 3,
  firmware: { uno: hexText },                     // Intel HEX text or flash words, per board id
  inputs: [{ t: 0.5, pot: 'pot1', value: 1 }, { t: 1, press: 'button1', holdMs: 50 }],
  mechanics: 'static',                            // 'off' | 'static' (gravity loads, clash checks) | 'dynamic' (Rapier)
});
report.ok;        // false on error checks, overlapping parts or an actuator loaded past its stall/holding torque
report.problems;  // one line per reason
```

`shareUrl(project, { uno: hexText })` in `src/lab/share.ts` turns the same bench into a link to the public site, so a tool can hand over what it has just checked.

The report holds every check with the times it was first and last seen and whether it is still there at the end (pins float until `setup()` runs, so some checks clear by themselves), serial output per board, device states and joint angles sampled every 50 ms (configurable), each actuator's peak load as a share of its limit, clashes, tendon tension and slack, and, with dynamics, how far each joint lagged its servo, which parts touched and where dropped objects ended up. Warnings are reported but do not make `ok` false.

### Use it from an AI agent (MCP)

Orrery is also an [MCP](https://modelcontextprotocol.io) server, so a coding agent you already use (Claude Code, Cursor, Gemini CLI, …) can design a bench, run it and fix it with its own model. It runs on your machine over stdio and compiles with your arduino-cli; nothing is sent anywhere.

```bash
npm install && npm run build:mcp          # → dist-mcp/server.mjs
claude mcp add orrery -- node /path/to/orrery/dist-mcp/server.mjs
```

Other clients take the same command in their MCP settings, e.g. `{"mcpServers": {"orrery": {"command": "node", "args": ["/path/to/orrery/dist-mcp/server.mjs"]}}}`.

| Tool | What it does |
|---|---|
| `orrery_guide` | The workflow, the [project format](docs/project-format.md), the [assembly format](docs/assembly-format.md), every device with its pins and part number, the templates |
| `orrery_get_template` | A working template project to start from |
| `orrery_check` | Fast check without firmware: wires and devices the simulator would ignore (unknown pins or kinds), shorts, assembly errors, mass, parts overlapping in the home pose |
| `orrery_compile` | Compile every board's sketch (unchanged templates use their prebuilt firmware; results are cached per sketch) |
| `orrery_simulate` | Compile and run up to 60 s with timed inputs; returns the headless report above, trimmed to the samples and devices asked for |
| `orrery_share` | A link that opens the bench, firmware included, in the web app |

The loop the server suggests: guide → template or new project → check → simulate with inputs that exercise the design → fix → share. `ok: true` only means nothing is broken; the agent still has to compare the samples with what was asked.

### Benchmark: can a model design a working build?

`bench/` asks models to build things from a sentence and lets the simulator grade them. Each task is a description ("a potentiometer steers an SG90 from 0° to 180°", "lift a 250 g weight by 45° with an SG90 without passing 80 % of its stall torque"). The model works with the MCP tools above until it calls `submit`. The grader then runs the submitted bench itself, with inputs the model never sees (button presses, pot positions, serial lines), and measures what happened: LED states, servo and stepper angles, serial output, joint angles and actuator loads. A design passes only if the bench is also clean: no ignored wires, no error checks, no clashes, no overloads.

30 tasks; `npm run bench -- --list` names them all.

| Group | Tasks | What the graders measure |
|---|---|---|
| Timing and output | `blink-2hz`, `sos-morse`, `pwm-fade`, `traffic-light` | LED on/off durations to ±15–20 ms, a 2 s PWM fade cycle to ±0.1 s, the light sequence to ±0.1 s |
| Inputs | `button-toggle-led`, `button-counter-serial`, `long-press`, `pot-servo`, `pot-threshold` | LED or serial state after presses of a bouncing button (short and held), servo angle at pot positions, a threshold with hysteresis |
| Serial protocols | `serial-pong`, `serial-led-command`, `serial-servo-command`, `serial-adc-read` | exact replies to command lines, including wrong ones; the LED, servo angle (±2°) or ADC count (±4) they set or read |
| Circuits | `led-from-psu`, `divider-adc` | LED current 10 ± 1 mA from a 9 V supply with no board; a ≥ 1 kΩ divider giving 2000 ± 50 mV on A0 |
| Servos and power | `two-servos-mirror`, `servo-slow-sweep`, `six-servo-supply` | angles at pot positions (±5°), a 60°/s sweep (±8°), servos powered from a bench supply |
| Steppers | `stepper-one-rev`, `stepper-pot-position`, `stepper-button-jog`, `stepper-microstep`, `stepper-speed` | shaft angle (±1.8°, ±0.3° in 1/16 steps), 360°/s ± 1 %, the driver wired as Pololu recommends, no lost steps |
| Several boards | `two-board-relay`, `two-board-servo` | a button or pot on one board acting on the other over serial |
| Mechanisms | `arm-lift`, `heavy-lift`, `gripper-close`, `pan-tilt`, `arm-two-joint-reach` | link poses from the assembly: a bar horizontal / vertical (±5°), 250 g lifted 45 ± 3° under 80 % of stall, fingertip pads ≤ 10 mm apart with no overlap, camera pan/tilt (±5°), an arm tip at a point (±5 mm) |

Every task has a reference solution in `bench/solutions/`, and the tests check that each grader passes it and fails at least one specific wrong answer per task (the 1 Hz Blink, an LED with no resistor, servos on the Uno's 5 V pin, MS pins left open, a missing TX→RX wire, a direct drive that overloads the servo, an uncoupled second finger, …).

```bash
npm run bench -- --list
npm run bench -- --model vertex:gemini-2.5-pro --model openai:gpt-5 --repeat 3
npm run bench -- --model anthropic:claude-sonnet-4-5 --task arm-lift --task heavy-lift
```

| Provider | Model name | Credentials (environment only) |
|---|---|---|
| `vertex:` | Gemini on Vertex AI | `VERTEX_API_KEY`, or `GOOGLE_APPLICATION_CREDENTIALS` (service-account key file) or `VERTEX_ACCESS_TOKEN`; `VERTEX_PROJECT` / `VERTEX_LOCATION` (default `global`) |
| `gemini:` | Gemini on Google AI Studio | `GEMINI_API_KEY` |
| `openai:` | OpenAI, or any OpenAI-compatible endpoint (Qwen on DashScope or OpenRouter, Ollama, vLLM) | `OPENAI_API_KEY`, `OPENAI_BASE_URL` |
| `anthropic:` | Claude | `ANTHROPIC_API_KEY` |

Sketches compile with the arduino-cli on your machine. Each run writes `bench/runs/<time>/` (git-ignored): one JSON per episode with the transcript, the submitted project and every grading criterion, plus `summary.md` with pass rate, simulations per passing design, turns and tokens per model. Provider failures (missing key, network, HTTP errors) are listed but not scored. No results are published yet.

## Real parts, with part numbers

Every device is a specific product you can buy; its model uses that product's datasheet (sources are cited in [`src/sim/catalog.ts`](src/sim/catalog.ts)), and the BOM panel lists them with links and exports CSV.

| Part | Manufacturer / MPN | What the model takes from the datasheet |
|---|---|---|
| Arduino UNO R3 | Arduino A000066 | 68.6 × 53.4 mm, 8.5 mm headers, D13 "L" LED (1 kΩ, LMV358 buffer), 500 mA USB polyfuse, VIN 7–12 V |
| ATmega328P (on the Uno) | Microchip | VOH 4.1 V / VOL 0.8 V at 20 mA, 40 mA per pin max, pull-up 20–50 kΩ, VIL 0.3 VCC / VIH 0.6 VCC |
| Micro servo | TowerPro SG90 | 0.1 s / 60° slew, 1.8 kgf·cm, 4.8–6 V; pulse 544–2400 µs → 0–180° (Arduino Servo library) |
| Stepper driver | Pololu 1182 (Allegro A4988) | VMOT 8–35 V, VDD 3–5.5 V, logic 0.7/0.3 VDD, MS1–3 pull-downs and step table, RST/SLP/EN, 1 ms wake, STEP ≥ 1 µs, 47 µF on VMOT |
| Stepper motor | SOYO SY42STH38-1684A (Pololu 2267) | bipolar 4-wire, 200 steps/rev, 42.3 × 38 mm, 1.68 A/coil |
| Push button | Omron B3F-1000 | 6 × 6 mm, 100 mΩ contact, bounce ≤ 5 ms |
| Potentiometer | Bourns PTV09A-2020F-B103 | 10 kΩ linear, 280° travel |
| LED | Kingbright WP7113ID | VF 1.9 V, 30 mA max |
| Resistor, capacitor, bench supply | generic | value set in the inspector |

**Approximations** (marked "approx." in the UI and code): TowerPro publishes no SG90 current (the model uses the low end of the 0.5–2 A its site quotes while the horn moves); the Uno datasheet leaves its own consumption blank (50 mA is an estimate); the stepper's maximum step rate (1000 steps/s) is an estimate because no pull-out torque curve is published; the bounce pattern is invented within the 5 ms limit; the ATmega pull-up uses the midpoint of 20–50 kΩ; the LED's series resistance (10 Ω) is not in its datasheet; Pololu does not publish the A4988 carrier's SLP pull-up or EN pull-down (inferred from its minimal wiring, 100 kΩ assumed); some board-feature positions and the SG90 tab span are read from outlines.

## Roadmap — what a robot or IoT build needs

| Area | Planned |
|---|---|
| Boards | Arduino Nano / Mega (AVR), Raspberry Pi Pico ([rp2040js](https://github.com/wokwi/rp2040js)), **ESP32** for WiFi |
| Buses | I2C, SPI, interrupts, serial plotter |
| Sensors | HC-SR04 ultrasonic, MPU6050 IMU, DHT22, LDR, PIR, rotary encoder, limit switch |
| Actuators | DC motor + L298N, ULN2003 + 28BYJ-48, relay, buzzer, RGB LED, NeoPixel |
| Displays | LCD 1602 (I2C), SSD1306 OLED, 7-segment |
| Power | Battery and regulator models, supply current limits, brown-out |
| Connectivity | ESP32 WiFi bridged to real MQTT / HTTP / WebSocket servers |
| Mechanics | Physics engine (joint torque, gravity, collisions), STEP import, an assembly editor, sensors that measure the 3D scene |
| Workflow | Breadboard view, hosted compile service, simulation in a Web Worker |

## Run it

```bash
npm install
npm run dev              # http://localhost:5173
npm run compiler         # optional: local compile helper (needs arduino-cli)
npm test                 # simulator, circuit and wiring-mistake tests with real firmware
npm run build            # static site in dist/
npm run build:examples   # recompile examples/*.ino into public/examples/*.hex
npm run build:mcp        # MCP server for AI agents → dist-mcp/server.mjs
npm run bench -- --list  # design benchmark (see above)
```

## How it works

```
sketch.ino ─► compile helper (arduino-cli) ─► .hex ─► avr8js CPU (16 MHz) ─► pin edges with cycle timestamps
                                                          ▲                         │
                                     input voltages ◄─ circuit solver ◄─ your wires + part models ─► 3D + checks
```

The CPU runs in 1 ms slices. Every output edge re-solves the bench circuit at that instant (pin drivers as 45 Ω / 40 Ω sources from the ATmega328P's VOH/VOL, resistors, the pot divider, closed contacts, LEDs as VF + series resistance, supplies), and input pins are set from the solved voltages. Servo and STEP/DIR edges reach the part models with their exact CPU cycle, so pulse widths are measured to the cycle.

## Layout

```
src/lab/devices.ts   shelf parts: real pins, internal links, 2D pin positions
src/lab/project.ts   project file (devices, wires, code) and its validation
src/lab/templates.ts the shelf templates (sketches, mechanisms, prebuilt firmware names)
src/lab/share.ts     share links: shareHash / shareUrl / readShareHash (browser and Node)
src/lab/circuit.ts   nets from wires; DC solver (modified nodal analysis)
src/lab/labsim.ts    firmware + circuit + part models; wiring checks
src/headless/run.ts  runProject: a whole run without a browser, as one JSON report
src/lab/Wiring.tsx   wiring canvas;  CodeEditor.tsx  sketch editor;  compiler.ts  helper client
src/mech/assembly.ts Orrery Assembly Format: types, validator, kinematics, AI prompt (spec: docs/assembly-format.md)
src/mech/solid.ts    printable solids (manifold), STL;  drawing.ts  A4 drawings;  fabricate.ts  fabrication ZIP
src/mech/LabPanel.tsx 3D lab editor;  edit.ts  assembly edits
src/sim/board.ts     Arduino Uno: CPU, timers, ports, ADC, USART (avr8js)
src/sim/parts.ts     servo, A4988 + stepper, button, potentiometer models
src/sim/catalog.ts   real parts: MPNs, links and the datasheet figures the models use
src/Scene.tsx        3D bench in millimetres
scripts/compile-server.mjs   local compile helper;  arduino-cli.mjs  the compile step it shares with the MCP server
src/mcp/             MCP server: tools.ts (the tools), server.ts (stdio)
bench/               benchmark: tasks.ts (tasks + graders), agent.ts (episode loop), providers.ts, run.ts (CLI), solutions/
examples/            template sketches;  public/examples/  their prebuilt .hex
```

## License

MIT

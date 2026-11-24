# Orrery

**Build robots and IoT devices in the browser before you build them for real.**

An orrery is a clockwork model that reproduces the motion of the real thing. Orrery does that for hardware. It is a **custom lab**: the bench gives you real parts with real pins, you wire them pin to pin, write the sketch, and Orrery runs the **compiled Arduino firmware** cycle by cycle against the circuit you built. Wiring mistakes, power problems and timing bugs show up on screen instead of on the bench.

**Live:** https://dinhgia2106.github.io/orrery/

## The lab

1. **Device shelf** — add an Arduino UNO R3 (always on the bench), micro servo, A4988 driver, NEMA 17 stepper, tactile switch, potentiometer, LED, resistor, electrolytic capacitor and bench supply. Every part has its real pins: the Uno's full headers (D0–D13, A0–A5, 5V, 3V3, VIN, three GND, SDA/SCL = A4/A5), the A4988 carrier's 16 pins (EN, MS1–3, RST, SLP, STEP, DIR, VMOT, GND, 1A/1B/2A/2B, VDD), the B3F's four legs (1–2 and 3–4 are the same contact).
2. **Wiring** (FIG. 1) — click a pin, then another pin, to run a jumper wire. Drag parts, pan, zoom; hover a Uno pin to see its mode and voltage; select a wire to recolour or delete it.
3. **Sketch** — write Arduino C++ in the editor and press **Compile & run** (Ctrl+Enter). Errors are marked on their lines.
4. **Run** — the firmware runs on an emulated ATmega328P; the bench circuit is solved from your wiring (DC nodal analysis) every time an output pin changes, so inputs see real voltages: pull-ups, dividers, an open button, a floating pin.
5. **3D bench** (FIG. 2) — the same project at real scale, laid out like your wiring view.

Projects autosave in the browser, save/open as `.orrery.json`, and **Share** puts the whole project in a link. Five templates (Blink, Servo sweep, Stepper + A4988, Two-joint robot arm, Five-finger robot hand) come wired and with prebuilt firmware, so they run even without a compiler.

### Mechanisms: the Orrery Assembly Format

3D mechanisms are JSON files in the **[Orrery Assembly Format](docs/assembly-format.md)** ([JSON Schema](public/schema/orrery-assembly-1.schema.json)): rigid *links* (box, cylinder, capsule, sphere or your STL, with material and how each is made), *joints* that join them into a tree (revolute, prismatic, fixed, with axis and limits) driven by a bench servo or stepper or *following* another joint by a ratio (tendons, gears), *mounts* that build bench devices into a link, and a *hardware* list. It is URDF's model in millimetres and degrees, bound to the bench.

- **Import** an assembly or an STL; devices it mounts that the bench lacks are added, ready to wire.
- **Ask an AI**: the lab copies a prompt with the rules, an example and the schema; paste the answer back and the validator lists every problem in plain words.
- The 3D view moves the joints from the running firmware; a drive pushing a joint past its limit is reported; printed parts and hardware join the BOM.
- Example — what a robot hand needs: [`examples/robot-hand/robot-hand.assembly.json`](examples/robot-hand/robot-hand.assembly.json) (forearm, wrist, palm, 14 phalanges, tendon-coupled finger joints, six SG90s, tendon line, sheaths, return elastics, hinge pins, a wrist bearing).

Kinematics only: masses, forces, torques and collisions are not simulated.

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
src/lab/project.ts   project file (devices, wires, code), templates, share links
src/lab/circuit.ts   nets from wires; DC solver (modified nodal analysis)
src/lab/labsim.ts    firmware + circuit + part models; wiring checks
src/lab/Wiring.tsx   wiring canvas;  CodeEditor.tsx  sketch editor;  compiler.ts  helper client
src/mech/assembly.ts Orrery Assembly Format: types, validator, kinematics, AI prompt (spec: docs/assembly-format.md)
src/sim/board.ts     Arduino Uno: CPU, timers, ports, ADC, USART (avr8js)
src/sim/parts.ts     servo, A4988 + stepper, button, potentiometer models
src/sim/catalog.ts   real parts: MPNs, links and the datasheet figures the models use
src/Scene.tsx        3D bench in millimetres
scripts/compile-server.mjs   local compile helper
examples/            template sketches;  public/examples/  their prebuilt .hex
```

## License

MIT

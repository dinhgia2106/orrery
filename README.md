# Orrery

**Build robots and IoT devices in the browser before you build them for real.**

An orrery is a clockwork model that reproduces the motion of the real thing. Orrery does that for hardware: it runs your **real compiled Arduino firmware**, cycle by cycle, against simulated circuits, motors and a 3D mechanism — so wiring mistakes, power problems and timing bugs show up on screen instead of on the bench.

**Live:** https://dinhgia2106.github.io/orrery/

## What works today

- **Arduino Uno running real firmware** — an ATmega328P emulated instruction by instruction with [avr8js](https://github.com/wokwi/avr8js) (timers, GPIO, ADC, UART). Load any `.hex` built by Arduino IDE / `arduino-cli`.
- **Parts that behave like the hardware**
  - LED with PWM brightness
  - Hobby servo: angle from the pulse width (544–2400 µs), finite slew speed like an SG90
  - Stepper behind an A4988 driver: STEP/DIR pulses, and steps that come too fast are **lost**, as on a real motor
  - Push button (INPUT_PULLUP) and potentiometer you can operate while the firmware runs
- **3D mechanism** — a two-joint arm whose base follows the servo and whose elbow follows the stepper.
- **Checks** — 5 V rail current against the 500 mA a USB port gives; servo driven by `analogWrite()` instead of the Servo library; pulses outside a servo's range; stepper stall.
- **Serial monitor** for `Serial.print()`.

## Roadmap — what a robot or IoT build needs

| Area | Planned |
|---|---|
| Boards | Arduino Nano / Mega (AVR), Raspberry Pi Pico ([rp2040js](https://github.com/wokwi/rp2040js)), **ESP32** for WiFi |
| Buses | I2C, SPI, interrupts, serial plotter |
| Sensors | HC-SR04 ultrasonic, MPU6050 IMU, DHT22, LDR, PIR, rotary encoder, limit switch |
| Actuators | DC motor + L298N, ULN2003 + 28BYJ-48, relay, buzzer, RGB LED, NeoPixel |
| Displays | LCD 1602 (I2C), SSD1306 OLED, 7-segment |
| Power | Battery and regulator models, per-rail current budget, brown-out |
| Connectivity | ESP32 WiFi bridged to real MQTT / HTTP / WebSocket servers |
| Mechanics | Physics engine (joint torque, gravity, collisions), STL / STEP import, sensors that measure the 3D scene |
| Workflow | Visual wiring editor, in-browser code editor with a compile service, shareable project links, BOM export |

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # simulator tests (includes real AVR machine code)
npm run build      # static site in dist/
```

The *Blink (hand-assembled)* example is 18 words of AVR machine code and runs with no toolchain. The other examples are Arduino sketches in [`examples/`](examples/); their compiled `.hex` files are committed in [`public/examples/`](public/examples/), and `npm test` runs each of them through the simulator. After editing a sketch, rebuild them with [arduino-cli](https://arduino.github.io/arduino-cli/):

```bash
arduino-cli core install arduino:avr
arduino-cli lib install Servo
npm run build:examples   # writes public/examples/*.hex
```

## How it works

```
firmware .hex ─► avr8js CPU (16 MHz) ─► pin edges with cycle timestamps ─► part models ─► 3D scene + checks
                     ▲                                                        │
                     └──────────── button / potentiometer / sensor inputs ◄───┘
```

The CPU runs in 1 ms slices; after each slice every part updates its dynamics (servo slew, stepper position, LED duty). Pin edges carry the exact CPU cycle at which they happened, so pulse widths are measured to the cycle — the same signal a real servo or driver sees.

## Layout

```
src/sim/board.ts    Arduino Uno: CPU, timers, ports, ADC, USART; pin mapping and edge events
src/sim/parts.ts    LED, servo, stepper + A4988, button, potentiometer
src/sim/engine.ts   wiring, time slicing, power check, snapshots for the UI
src/sim/hex.ts      Intel HEX reader / writer
src/sim/demos.ts    hand-assembled Blink
public/examples/    compiled example firmware (arduino-cli, arduino:avr 1.8.8)
src/Scene.tsx       3D board and arm (three.js, react-three-fiber)
src/App.tsx         workbench UI
examples/           Arduino sketches for the examples
```

## License

MIT

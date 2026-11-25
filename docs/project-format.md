# Orrery project format (version 1)

A project is one JSON document: the devices on the bench, the jumper wires between their pins, the Arduino sketch of every board and, optionally, a 3D mechanism. The app saves it as `.orrery.json`, keeps it in the browser and packs it into share links; the MCP tools take it as JSON or as a path to such a file.

```json
{
  "version": 1,
  "name": "Servo sweep",
  "devices": [
    { "id": "uno", "kind": "uno", "x": 0, "y": 0, "props": {} },
    { "id": "servo1", "kind": "servo", "x": 440, "y": 70, "props": {} }
  ],
  "wires": [
    { "id": "w1", "a": "servo1.SIG", "b": "uno.D9", "color": "#f28c1a" },
    { "id": "w2", "a": "servo1.V+", "b": "uno.5V", "color": "#e53935" },
    { "id": "w3", "a": "servo1.GND", "b": "uno.GND1", "color": "#1f1f1f" }
  ],
  "code": "#include <Servo.h>\nServo s;\nvoid setup() { s.attach(9); }\nvoid loop() { s.write(0); delay(1000); s.write(180); delay(1000); }\n",
  "sketches": {}
}
```

| Field | Meaning |
|---|---|
| `version` | Always `1`. |
| `name` | Shown in the app, up to 80 characters. |
| `devices[]` | `id` (unique; wires refer to it), `kind` (see below), `x`/`y` (position on the 2D wiring canvas; any numbers), `props` (values for resistors, capacitors and supplies). |
| `wires[]` | `a` and `b` are pins written `deviceId.PIN`. `id` and `color` are free. A wire to a pin that does not exist is ignored by the simulator; the MCP `orrery_check` tool reports it. |
| `code` | The sketch of the board with id `uno`. |
| `sketches` | Sketches of further boards by id (`uno2`, `uno3`, …). |
| `assembly` | The 3D mechanism in the [Orrery Assembly Format](assembly-format.md), or left out. Servos and steppers drive its joints by device id. |

## Device kinds

`orrery_guide` with topic `devices` lists every kind with its real part number, pins, internal connections and default props. In short:

| Kind | Part | Pins | Props |
|---|---|---|---|
| `uno` | Arduino UNO R3 (A000066) | `D0`–`D13`, `A0`–`A5`, `5V`, `3V3`, `VIN`, `GND1`–`GND3`, `IOREF`, `SDA`, `SCL` (GND1–3 are one net; `IOREF` = `5V`, `SDA` = `A4`, `SCL` = `A5`) | — |
| `servo` | TowerPro SG90 | `SIG`, `V+`, `GND` | — |
| `a4988` | Pololu 1182 (A4988 carrier) | `STEP`, `DIR`, `EN`, `MS1`–`MS3`, `RST`, `SLP`, `VDD`, `GND`, `VMOT`, `GND_M`, `1A`, `1B`, `2A`, `2B` (`GND_M` = `GND`) | — |
| `stepper` | NEMA 17, SY42STH38-1684A | `A+`, `A-`, `B+`, `B-` | — |
| `button` | Omron B3F-1000 | `1`–`4` (`1`–`2` and `3`–`4` are joined inside) | — |
| `pot` | Bourns PTV09A, 10 kΩ linear | `1`, `W`, `3` | — |
| `led` | Kingbright WP7113ID, 5 mm red | `A`, `K` | `color` |
| `resistor` | ¼ W resistor | `1`, `2` | `ohms` (220) |
| `cap` | electrolytic capacitor | `+`, `-` | `uf` (100) |
| `psu` | bench supply | `+`, `-` | `volts` (12) |

## Boards

Boards are ordinary devices; there can be any number. The first is `uno` and its sketch is `code`; further boards are `uno2`, `uno3`, … with sketches in `sketches`. A wire from one board's `D1` (TX) to another's `D0` (RX) carries serial bytes. With no board on the bench, the first bench supply's `−` is 0 V.

## Share links

`#z=` + base64url(deflate-raw(JSON)) of `{"format":"orrery.share","version":1,"project":{…},"firmware":{"uno":"<Intel HEX>"}}` after the page URL, e.g. `https://dinhgia2106.github.io/orrery/#z=…`. `firmware` is optional; with it the link runs without a compiler.

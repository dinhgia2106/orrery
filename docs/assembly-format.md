# Orrery Assembly Format, version 1

A mechanism for the Orrery lab, written as JSON, so a person can export it from their own work and import it, and an AI can write it from a description. It answers three questions about a build:

1. **What are the parts?** Rigid *links*, each with a shape, a material and how it is made (print, buy, cut, machine).
2. **How do they move?** *Joints* that join links into a tree and say what drives each one: a servo or stepper on the bench, or another joint through a fixed ratio (tendons, gears, linkages).
3. **What is built into it?** *Mounts* that place bench devices (servos, steppers, drivers, buttons…) on a link — importing an assembly adds any missing device to the bench, ready to wire — and *tendons*, the lines those actuators pull.

Plus *hardware* (screws, bearings, tendon line, springs) and *notes* (assumptions, assembly steps).

- JSON Schema: [`public/schema/orrery-assembly-1.schema.json`](../public/schema/orrery-assembly-1.schema.json), served at `https://dinhgia2106.github.io/orrery/schema/orrery-assembly-1.schema.json`
- Validator, kinematics and the AI prompt: [`src/mech/assembly.ts`](../src/mech/assembly.ts)
- Examples: [`examples/robot-arm/robot-arm.assembly.json`](../examples/robot-arm/robot-arm.assembly.json), [`examples/robot-hand/robot-hand.assembly.json`](../examples/robot-hand/robot-hand.assembly.json)

It borrows URDF's model (links + joints in a tree, child frames placed in the parent frame), with these differences: millimetres and degrees instead of metres and radians, Euler XYZ rotations, primitives sized the way people describe parts, and drives that bind joints to the devices on the Orrery bench.

## Conventions

- Units: millimetres and degrees. **Y is up.** The root link stands on the bench at y = 0.
- Rotations are Euler angles applied X, then Y, then Z, in degrees.
- Ids start with a letter and use letters, digits, `_` and `-` (up to 48 characters). Link and joint ids share one namespace.

## Top level

| Field | Required | Meaning |
|---|---|---|
| `format` | yes | `"orrery.assembly"` |
| `version` | yes | `1` |
| `name` | yes | Short name |
| `units` | yes | `"mm"` |
| `description` | | One paragraph |
| `placement` | | `[x, y, z]` mm from the Uno's centre where the root link stands |
| `links` | yes | 1–400 links |
| `joints` | yes | May be empty (a single rigid part) |
| `mounts` | | Bench devices built into the mechanism |
| `hardware` | | `{ "item", "qty", "note" }` — generic, no invented part numbers |
| `notes` | | Strings: assumptions, assembly steps, what is not modelled |

## Links

```json
{ "id": "index_prox", "label": "index finger, proximal phalanx",
  "shape": { "capsule": { "r": 9, "h": 22 } }, "position": [0, 20, 0],
  "material": "PLA", "make": "print", "color": "#f4f6f9" }
```

`shape` is exactly one of:

| Shape | Size |
|---|---|
| `{"box": [x, y, z]}` | edge lengths |
| `{"cylinder": {"r", "h"}}` | radius, length along local Y |
| `{"capsule": {"r", "h"}}` | radius, straight length along local Y (total length h + 2r) |
| `{"sphere": r}` | radius |
| `{"mesh": {"url" \| "data", "scale"}}` | an STL in millimetres: `https://` URL, a relative path, or a `data:` URL under 4 MB |

`massG` (grams) overrides the mass Orrery computes as solid volume × density — use it for meshes, infilled or hollow prints, and materials without a sourced density.

`position` / `rotation` place the shape in the link's own frame (the frame its parent joint defines). `opacity` (0–1) lets a shell show what is mounted inside.

### Features — making printed parts real

`features` turn a primitive link into a part you can print: everything is in the link frame (mm), holes and cuts are subtracted, bosses are added, and the result is one watertight solid (built with [manifold](https://github.com/elalish/manifold)).

| Feature | Meaning |
|---|---|
| `{"hole": {"d", "position", "axis", "depth"}}` | Round hole of diameter `d` along local `x`, `y` or `z` (default `y`); through the part unless `depth` is given (then centred on `position`). M3 clearance 3.4 mm, M2 2.4 mm (ISO 273 medium). |
| `{"cut": {"box", "position", "rotation"}}` | Remove a box. |
| `{"pocket": {"for", "position", "rotation", "clearance"}}` | A cut-out that fits a real part, through along local Y: `sg90` (body 23.1 × 12.2), `nema17` (φ22 pilot + 4 × φ3.4 on the 31 mm square of the SY42STH38-1684A drawing), `a4988` (20.32 × 15.24), `b3f` (6 × 6). `clearance` per side defaults to 0.2 mm — a printing allowance, not a datasheet value. |
| `{"add": {"shape", "position", "rotation"}}` | Add material: a boss, rib or tab (any primitive shape). |

The SG90's tab screw-hole spacing is not in a drawing we could read, so the `sg90` pocket is the body outline only: measure your servo and add the two screw holes yourself.

## Joints

```json
{ "id": "index_pip", "type": "revolute", "parent": "index_prox", "child": "index_mid",
  "position": [0, 40, 0], "axis": [1, 0, 0], "limits": [0, 100],
  "drive": { "follow": "index_mcp", "ratio": 1.0 } }
```

| Field | Meaning |
|---|---|
| `type` | `revolute` (degrees), `prismatic` (mm) or `fixed` |
| `parent`, `child` | Link ids. Every link except the root has exactly one parent joint; no loops |
| `position`, `rotation` | The child frame in the parent frame, at joint value 0 |
| `axis` | Motion axis in the child frame |
| `limits` | `[min, max]`; the joint stops there (Orrery reports a drive pushing past a stop). Omit for continuous rotation |
| `home` | Value when nothing drives it |
| `drive` | See below |

### Drives

- **From a device** — `{"device": "servo1", "from": [0, 180], "to": [-90, 90]}`: the joint value is the device angle mapped linearly from `from` to `to` (defaults: `from` = `[0, 180]`, `to` = `from`). A servo's angle is its horn angle (0–180°); a stepper's is its shaft angle in degrees, unbounded. The device must appear in `mounts`.
- **From another joint** — `{"follow": "index_mcp", "ratio": 0.75, "offset": 0}`: value = ratio × that joint + offset. Use it for tendons that curl several joints together, gear trains, parallel linkages.

### Axles

`"axle": {"size": "M2", "length": 20}` on a revolute joint is the screw it turns on: along the axis, centred on the joint origin, held by the parent. Orrery draws it with its head (ISO 4762) and nut (ISO 4032) and counts it as hardware; cut matching clearance holes (M2 2.4 mm, M3 3.4 mm) in both parts.

## Tendons

```json
{"id": "index_mcp_flex", "label": "index knuckle flexor", "device": "servo1", "spool": 6.21, "wind": 1, "path": [{"link": "forearm", "at": [-31.15, 56.5, 23], "sheath": true}, {"link": "palm", "at": [-21.5, 50, 10]}, {"link": "palm", "at": [-21.5, 142, 10]}, {"link": "index_prox", "at": [-4.5, 19.5, 10]}]}
```

A line pulled by a printed spool on the shaft of a mounted servo or stepper, from the spool to an anchor.

| Field | Meaning |
|---|---|
| `device` | The servo or stepper (in `mounts`) whose shaft carries the spool. The spool seats where the SG90 horn does; its two grooves are 1.5 and 4 mm above the seat (`wind` 1 and −1), so a flexor and an extensor can share a servo |
| `spool` | Groove radius, mm: the line moves spool × device angle (radians) |
| `wind` | `1`: the spool reels the line in as the device angle grows; `-1`: it pays it out |
| `path` | Points from the spool to the anchor (the last point). `{"link", "at"}` is a guide fixed on a link (eyelet, channel end, sheath stop); `"sheath": true` makes the run to the next point a sheath (the line inside keeps its length, like a Bowden cable). `{"wrap": jointId, "r"}` is the round end of a revolute joint: the line wraps it (radius r about its axis) wherever the straight path would cut through it — the short way round, or always one way with `"sense": 1` or `-1` (right hand about the axis) |

What Orrery does with it: draws the line (wound on the spool, in its sheaths, through its guides), measures its length every frame and reports **slack** (positive) or **stretch** (negative) against what the spool has reeled in, and its **tension** = the actuator's torque share ÷ spool radius (inextensible, frictionless line). Choose the spool radius so spool × device angle equals what the joints take up (moment arm × joint angle, summed over the joints the line crosses); the slack readout shows what is left. Joints still move by their `drive`: tendons do not add constraints.

## Mounts

```json
{ "device": "servo2", "kind": "servo", "link": "forearm", "position": [20, 4, 0] }
```

Places a bench device on a link; Orrery draws its real model there (SG90, NEMA 17, A4988 carrier, B3F switch, PTV09 pot, LED, resistor, capacitor). `kind` is a shelf kind: `servo`, `stepper`, `a4988`, `button`, `pot`, `led`, `resistor`, `cap`. If the bench has no device with that id, importing adds one; wiring it and writing the sketch are up to you. Real sizes to leave room for: SG90 23.1 × 12.2 × 29 mm (origin of its model: the output shaft axis at the case bottom), NEMA 17 42.3 × 42.3 × 38 mm (origin: shaft axis on the front face, body towards −Z), A4988 carrier 20.3 × 15.2 mm.

## What Orrery does with it

- **3D lab** (FIG. 2): build or edit the assembly part by part — shapes, poses, joints, drives, features, mounts — drag a selected part's joint with the gizmo (1 mm steps). Parts with features are shown as their exact printable solid.
- **Make it**: per part, a binary STL in millimetres and an A4 drawing (three views, third-angle projection, overall sizes, feature list, title block); for the whole mechanism, a fabrication package ZIP with `parts/*.stl`, `drawings/*.svg`, `bom.csv` (electronics with part numbers, made parts, hardware), `assembly.json` and a README.

- **3D**: builds the tree, moves joints every frame from the running firmware's servo and stepper angles, draws mounted devices and the wires to them.
- **Checks**: invalid files are rejected with one message per problem; joints whose drive asks for more than their limits are reported as sitting on a stop.
- **BOM**: printed / cut / machined links with material and bounding size, and the hardware list, next to the electronics.

Masses, gravity loads, collisions, tendon slack and tension and (with *Dynamics*) rigid-body motion are simulated from the geometry — see the README. Do not put torque or speed claims in an assembly that were not calculated; put assumptions in `notes`.

## Writing one with an AI

In the lab, *Mechanism → Ask an AI* builds a prompt with these rules, a small valid example, the schema link and your request. Paste it into any assistant, paste the JSON it returns into *Import JSON*, and fix whatever the validator lists.

## Example: what a robot hand needs

`examples/robot-hand/robot-hand.assembly.json` — 17 links, 16 joints, 6 mounted servos:

- **Links**: forearm shell (translucent, five SG90 pockets and sheath stops, the wrist servo inside), wrist disc on the wrist servo's horn, palm with hinge tabs, three phalanges per finger, two for the thumb — all printed PLA, with clevis forks and tongues and line eyelets as features.
- **Joints**: wrist rotation (servo 6, direct on its horn); for each finger a knuckle driven by its servo, the middle joint following the knuckle (ratio 1) and the tip following the middle (ratio 0.75); thumb knuckle and tip the same way. Every finger hinge turns on an M2 `axle`.
- **Mounts**: six SG90s in the forearm.
- **Tendons**: per finger a flexor on the palm side through all three joints and an extensor over their backs, both on one two-groove spool, through PTFE sheaths into the palm.
- **Hardware**: tendon line, PTFE tube, M2 hinge screws and nuts, servo screws, a 608 bearing for the wrist.
- **Bench** (template *Five-finger robot hand*): the six servos on a 5 V bench supply with its ground tied to the Uno's, a pot on A0 for grip, a button on D2 for the wrist.

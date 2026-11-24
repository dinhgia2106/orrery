# Orrery Assembly Format, version 1

A mechanism for the Orrery lab, written as JSON, so a person can export it from their own work and import it, and an AI can write it from a description. It answers three questions about a build:

1. **What are the parts?** Rigid *links*, each with a shape, a material and how it is made (print, buy, cut, machine).
2. **How do they move?** *Joints* that join links into a tree and say what drives each one: a servo or stepper on the bench, or another joint through a fixed ratio (tendons, gears, linkages).
3. **What is built into it?** *Mounts* that place bench devices (servos, steppers, drivers, buttons…) on a link. Importing an assembly adds any missing device to the bench, ready to wire.

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

It is **kinematics only**: no masses, forces, torques, friction or collisions are simulated. Do not put torque or speed claims in an assembly that were not calculated; put assumptions in `notes`.

## Writing one with an AI

In the lab, *Mechanism → Ask an AI* builds a prompt with these rules, a small valid example, the schema link and your request. Paste it into any assistant, paste the JSON it returns into *Import JSON*, and fix whatever the validator lists.

## Example: what a robot hand needs

`examples/robot-hand/robot-hand.assembly.json` — 17 links, 16 joints, 6 mounted servos:

- **Links**: forearm shell (translucent, holds the servos), wrist disc, palm, three phalanges per finger, two for the thumb — all printed PLA.
- **Joints**: wrist rotation (servo 6); for each finger a knuckle driven by its servo, the middle joint following the knuckle (ratio 1) and the tip following the middle (ratio 0.75) — the tendon pulling through all three; thumb knuckle and tip the same way.
- **Mounts**: six SG90s in the forearm.
- **Hardware**: tendon line, PTFE sheaths, return elastics, hinge pins, servo screws, a 608 bearing for the wrist.
- **Bench** (template *Five-finger robot hand*): the six servos on a 5 V bench supply with its ground tied to the Uno's, a pot on A0 for grip, a button on D2 for the wrist.

// Dexterous hand, board U1: flexion of the four fingers (knuckle + middle joint each) and the thumb
// (opposition, base, middle) — 11 SG90s on D2–D12. It steps through poses, easing every servo from one pose
// to the next, and tells board U2 which pose over Serial (TX/D1 → U2 RX/D0), so U2 can spread the fingers and
// move the wrist to match. Every knuckle and middle joint has its own servo, so the poses bend them apart:
// "knuckles" bends only the first segments, "hook" only the outer ones.
#include <Servo.h>

const byte PINS[11] = {2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12};
// servo angles: index mcp, pip · middle mcp, pip · ring mcp, pip · little mcp, pip · thumb rot, cmc, mcp
// (knuckles 0–180 → 0–90°, middle joints 0–180 → 0–100°, thumb opposition 0–180 → 0–90°,
//  thumb base 0–120 → 0–60°, thumb middle 0–180 → 0–70°; the tips follow the middle joints)
const byte POSES[][11] = {
  {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0},                        // 0 open
  {180, 180, 180, 180, 180, 180, 180, 180, 120, 80, 150},   // 1 fist
  {0, 0, 180, 180, 180, 180, 180, 180, 120, 80, 150},       // 2 point
  {0, 0, 0, 0, 180, 180, 180, 180, 120, 80, 150},           // 3 peace
  {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0},                        // 4 spread (U2 fans the fingers out)
  {100, 120, 0, 0, 0, 0, 0, 0, 150, 60, 90},                // 5 ok
  {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0},                        // 6 wave (U2 waves the wrist)
  {180, 0, 180, 0, 180, 0, 180, 0, 0, 0, 0},                // 7 knuckles: first segments only, fingers straight
  {0, 180, 0, 180, 0, 180, 0, 180, 0, 0, 0},                // 8 hook: outer segments only
  {0, 0, 0, 0, 0, 0, 180, 180, 120, 80, 150},               // 9 three
  {0, 0, 0, 0, 0, 0, 0, 0, 160, 100, 160},                  // 10 four: thumb folded across the palm
  {0, 0, 180, 180, 180, 180, 0, 0, 120, 80, 150},           // 11 rock
  {180, 180, 180, 180, 180, 180, 180, 180, 0, 0, 0},        // 12 thumbs up (U2 turns the wrist)
  {180, 180, 180, 180, 180, 180, 0, 0, 0, 0, 0},            // 13 call me
  {110, 90, 0, 0, 0, 0, 0, 0, 160, 70, 60},                 // 14 pinch: index tip to thumb tip
  {0, 0, 180, 180, 180, 180, 180, 180, 0, 0, 0},            // 15 gun
  {120, 110, 120, 110, 120, 110, 120, 110, 150, 60, 100},   // 16 grasp: round a ball
  {0, 0, 0, 0, 0, 0, 0, 0, 90, 40, 40},                     // 17 piano: fingers tap one after another
};
const char* const NAMES[] = {"open", "fist", "point", "peace", "spread", "ok", "wave", "knuckles", "hook",
                             "three", "four", "rock", "thumbs-up", "call-me", "pinch", "gun", "grasp", "piano"};
const byte COUNT = sizeof(POSES) / sizeof(POSES[0]);
const byte PIANO = 17;
const unsigned long EASE_MS = 400;  // move from one pose to the next
const unsigned long HOLD_MS = 2500; // time per pose, easing included

Servo servos[11];
float now[11];

void setup() {
  for (byte i = 0; i < 11; i++) {
    servos[i].attach(PINS[i]);
    now[i] = 0;
    servos[i].write(0);
  }
  Serial.begin(9600);
}

void loop() {
  for (byte p = 0; p < COUNT; p++) {
    Serial.print(p);
    Serial.print(' ');
    Serial.println(NAMES[p]);
    float from[11];
    for (byte i = 0; i < 11; i++) from[i] = now[i];
    unsigned long start = millis();
    while (millis() - start < HOLD_MS) {
      unsigned long t = millis() - start;
      // smoothstep: starts and ends gently
      float k = t >= EASE_MS ? 1 : (float)t / EASE_MS;
      k = k * k * (3 - 2 * k);
      for (byte i = 0; i < 11; i++) {
        float target = POSES[p][i];
        if (p == PIANO && i < 8 && t >= EASE_MS) {
          // each finger taps in turn: knuckle and middle joint bend together, 150 ms apart
          byte finger = i / 2;
          float phase = (float)(t - EASE_MS) / 600.0 - finger * 0.25;
          float s = sin(phase * 2 * PI);
          target = s > 0 ? s * (i % 2 ? 90 : 110) : 0;
        }
        now[i] = from[i] + (target - from[i]) * k;
        servos[i].write((int)(now[i] + 0.5));
      }
      delay(10);
    }
  }
}

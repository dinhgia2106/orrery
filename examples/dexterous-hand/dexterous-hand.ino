// Dexterous hand, board U1: flexion of the four fingers (knuckle + middle joint each) and the thumb
// (opposition, base, middle) — 11 SG90s on D2–D12. It steps through gestures and tells board U2 which one
// over Serial (TX/D1 → U2 RX/D0), so U2 can spread the fingers and move the wrist to match.
#include <Servo.h>

const byte PINS[11] = {2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12};
// servo angles: index mcp, pip · middle mcp, pip · ring mcp, pip · little mcp, pip · thumb rot, cmc, mcp
// (the thumb base servo works over 0–120°: its spool turns the base 1:2)
const byte GESTURES[][11] = {
  {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0},                    // 0 open
  {180, 180, 180, 180, 180, 180, 180, 180, 120, 80, 150},   // 1 fist
  {0, 0, 180, 180, 180, 180, 180, 180, 120, 80, 150},       // 2 point
  {0, 0, 0, 0, 180, 180, 180, 180, 120, 80, 150},           // 3 peace
  {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0},                    // 4 spread (U2 fans the fingers out)
  {100, 120, 0, 0, 0, 0, 0, 0, 150, 60, 90},            // 5 OK
  {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0},                    // 6 wave (U2 waves the wrist)
};
const char* const NAMES[] = {"open", "fist", "point", "peace", "spread", "ok", "wave"};
const byte COUNT = sizeof(GESTURES) / sizeof(GESTURES[0]);

Servo servos[11];

void setup() {
  for (byte i = 0; i < 11; i++) servos[i].attach(PINS[i]);
  Serial.begin(9600);
}

void loop() {
  for (byte g = 0; g < COUNT; g++) {
    for (byte i = 0; i < 11; i++) servos[i].write(GESTURES[g][i]);
    Serial.print(g);
    Serial.print(' ');
    Serial.println(NAMES[g]);
    delay(2500);
  }
}

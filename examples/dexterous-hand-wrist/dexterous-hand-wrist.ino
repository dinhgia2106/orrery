// Dexterous hand, board U2: finger spread (index, middle, ring, little on D2–D5) and the wrist
// (rotation D6, pitch D7). Reads "<pose> <name>" lines from U1 on RX/D0 and eases to match.
#include <Servo.h>

const byte PINS[6] = {2, 3, 4, 5, 6, 7};
// spread servo angles (90 = straight): index, middle, ring, little — larger tilts towards the thumb side.
// Each spread spool turns its knuckle 1:1, so index and little work over 75–105°, middle and ring over 80–100°.
// Then the wrist: rotation (0–180 → −90…90°) and pitch (0–180 → −45…45°).
const byte POSES[][6] = {
  {90, 90, 90, 90, 90, 90},    // 0 open
  {90, 90, 90, 90, 90, 110},   // 1 fist
  {90, 90, 90, 90, 90, 90},    // 2 point
  {100, 84, 90, 90, 90, 90},   // 3 peace: index and middle apart
  {105, 93, 87, 75, 90, 60},   // 4 spread: fan out, palm tipped back
  {90, 90, 90, 90, 60, 90},    // 5 ok
  {95, 91, 89, 85, 90, 90},    // 6 wave (the wrist swings, below)
  {90, 90, 90, 90, 90, 90},    // 7 knuckles
  {90, 90, 90, 90, 90, 100},   // 8 hook
  {98, 90, 84, 90, 90, 90},    // 9 three
  {102, 92, 88, 78, 90, 90},   // 10 four
  {100, 90, 90, 80, 120, 90},  // 11 rock
  {90, 90, 90, 90, 0, 90},     // 12 thumbs up: turn the hand so the thumb points up
  {90, 90, 90, 78, 120, 90},   // 13 call me
  {90, 90, 90, 90, 90, 80},    // 14 pinch
  {90, 90, 90, 90, 30, 90},    // 15 gun
  {92, 90, 90, 88, 90, 110},   // 16 grasp
  {90, 90, 90, 90, 90, 80},    // 17 piano
};
const byte COUNT = sizeof(POSES) / sizeof(POSES[0]);
const byte WAVE = 6;
const unsigned long EASE_MS = 400;

Servo servos[6];
float from[6], now[6];
byte pose = 0;
unsigned long since = 0;
String line;

void setup() {
  for (byte i = 0; i < 6; i++) {
    servos[i].attach(PINS[i]);
    from[i] = now[i] = POSES[0][i];
  }
  Serial.begin(9600);
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      if (line.length() && isDigit(line[0])) {
        int p = line.toInt();
        if (p >= 0 && p < COUNT) {
          pose = p;
          since = millis();
          for (byte i = 0; i < 6; i++) from[i] = now[i];
          Serial.print("pose ");
          Serial.println(line);
        }
      }
      line = "";
    } else if (c != '\r') {
      line += c;
    }
  }
  unsigned long t = millis() - since;
  float k = t >= EASE_MS ? 1 : (float)t / EASE_MS;
  k = k * k * (3 - 2 * k);
  for (byte i = 0; i < 6; i++) {
    float target = POSES[pose][i];
    // wave: swing the wrist rotation ±40° around the middle
    if (pose == WAVE && i == 4) target = 90 + 40 * sin(millis() / 250.0);
    now[i] = from[i] + (target - from[i]) * k;
    servos[i].write((int)(now[i] + 0.5));
  }
  delay(10);
}

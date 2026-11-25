// Dexterous hand, board U2: finger spread (index, middle, ring, little on D2–D5) and the wrist
// (rotation D6, pitch D7). Reads "<gesture> <name>" lines from U1 on RX/D0 and poses to match.
#include <Servo.h>

const byte PINS[6] = {2, 3, 4, 5, 6, 7};
// spread servo angles (90 = straight): index, middle, ring, little — larger tilts towards the thumb side.
// Each spread spool turns its knuckle 1:1, so index and little work over 75–105°, middle and ring over 80–100°.
const byte SPREAD[7][4] = {
  {90, 90, 90, 90},    // open
  {90, 90, 90, 90},    // fist
  {90, 90, 90, 90},    // point
  {100, 84, 90, 90},   // peace: index and middle apart
  {105, 93, 87, 75},   // spread: fan out
  {90, 90, 90, 90},    // ok
  {95, 91, 89, 85},    // wave
};
// wrist rotation, pitch
const byte WRIST[7][2] = {{90, 90}, {90, 110}, {90, 90}, {90, 90}, {90, 60}, {60, 90}, {90, 90}};

Servo servos[6];
byte gesture = 0;
String line;

void setup() {
  for (byte i = 0; i < 6; i++) servos[i].attach(PINS[i]);
  Serial.begin(9600);
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      if (line.length() && isDigit(line[0]) && line[0] - '0' < 7) {
        gesture = line[0] - '0';
        Serial.print("pose ");
        Serial.println(line);
      }
      line = "";
    } else if (c != '\r') {
      line += c;
    }
  }
  for (byte i = 0; i < 4; i++) servos[i].write(SPREAD[gesture][i]);
  servos[5].write(WRIST[gesture][1]);
  // wave: swing the wrist rotation ±40° around the middle
  servos[4].write(gesture == 6 ? 90 + 40 * sin(millis() / 250.0) : WRIST[gesture][0]);
  delay(10);
}

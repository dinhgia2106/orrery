// Reference solution: a two-link arm (100 mm upper arm, 80 mm forearm) starts straight up; a press of the
// button on D2 moves the tip to 120 mm out, 60 mm up from the shoulder axis; the next press brings it back.
// Both joints map servo 0..180 to +90..-90 degrees (90 = straight). Inverse kinematics, elbow on the outside:
//   cos(elbow) = (120^2 + 60^2 - 100^2 - 80^2) / (2 * 100 * 80) = 0.1        -> elbow 84.26 deg
//   shoulder   = atan2(120, 60) - atan2(80 sin(elbow), 100 + 80 cos(elbow)) -> 27.04 deg
// both measured clockwise from vertical, so the servos go to 90 + angle.
#include <Servo.h>

const int BUTTON = 2;
const unsigned long DEBOUNCE_MS = 20;

Servo shoulder, elbow;
bool reached = false;
int lastReading = HIGH;
int stableState = HIGH;
unsigned long changedAt = 0;

/** Servo.write with fractional degrees: 544..2400 us over 0..180 degrees. */
void writeDeg(Servo &s, float deg) {
  s.writeMicroseconds(544 + (int)(deg * (2400 - 544) / 180.0 + 0.5));
}

void pose() {
  writeDeg(shoulder, reached ? 90 + 27.04 : 90);
  writeDeg(elbow, reached ? 90 + 84.26 : 90);
}

void setup() {
  pinMode(BUTTON, INPUT_PULLUP);
  pose();
  shoulder.attach(9);
  elbow.attach(10);
}

void loop() {
  int reading = digitalRead(BUTTON);
  if (reading != lastReading) {
    changedAt = millis();
    lastReading = reading;
  }
  if (millis() - changedAt > DEBOUNCE_MS && reading != stableState) {
    stableState = reading;
    if (stableState == LOW) {
      reached = !reached;
      pose();
    }
  }
}

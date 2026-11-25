// Reference solution: a debounced button on D2 toggles the SG90 on D9 between 0 degrees (arm horizontal) and
// 180 degrees; a 4:1 gear reduction (servo 0..180 -> joint 0..45 degrees) lifts the 250 g weight by 45 degrees.
#include <Servo.h>

const int REST_DEG = 0;
const int RAISED_DEG = 180;

const int BUTTON = 2;
const unsigned long DEBOUNCE_MS = 20;

Servo servo;
bool raised = false;
int lastReading = HIGH;
int stableState = HIGH;
unsigned long changedAt = 0;

void setup() {
  pinMode(BUTTON, INPUT_PULLUP);
  servo.write(REST_DEG);
  servo.attach(9);
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
      raised = !raised;
      servo.write(raised ? RAISED_DEG : REST_DEG);
    }
  }
}

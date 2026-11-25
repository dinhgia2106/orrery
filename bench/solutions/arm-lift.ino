// Reference solution: a debounced button on D2 toggles the SG90 on D9 between 90 degrees (bar horizontal)
// and 180 degrees (bar straight up); the joint maps servo 0..180 to -90..90 degrees.
#include <Servo.h>

const int REST_DEG = 90;
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

// Two-joint arm: base servo on D9 follows the potentiometer on A0,
// elbow stepper (A4988, STEP D3 / DIR D4) goes to 90° and back each time the button on D2 is pressed.
#include <Servo.h>

const int STEP_PIN = 3;
const int DIR_PIN = 4;
const int BUTTON_PIN = 2;
const int POT_PIN = A0;

Servo base;
long elbowSteps = 0;
long elbowTarget = 50;  // 50 full steps = 90° on a 200-step motor
bool lastButton = HIGH;   // debounced level
bool lastReading = HIGH;  // raw level
unsigned long lastChangeMs = 0;
unsigned long lastStepUs = 0;

void setup() {
  pinMode(STEP_PIN, OUTPUT);
  pinMode(DIR_PIN, OUTPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_BUILTIN, OUTPUT);
  base.attach(9);
  Serial.begin(115200);
  Serial.println("arm ready: turn the pot, press the button");
}

void loop() {
  int angle = map(analogRead(POT_PIN), 0, 1023, 0, 180);
  base.write(angle);

  // Debounce: the Omron B3F contacts bounce for up to 5 ms, so a level only counts once it has been
  // stable for 10 ms.
  bool reading = digitalRead(BUTTON_PIN);
  if (reading != lastReading) {
    lastReading = reading;
    lastChangeMs = millis();
  }
  if (millis() - lastChangeMs >= 10 && reading != lastButton) {
    lastButton = reading;
    if (lastButton == LOW) {
      elbowTarget = elbowTarget == 0 ? 50 : 0;
      Serial.print("elbow -> ");
      Serial.println(elbowTarget);
    }
  }

  if (elbowSteps != elbowTarget && micros() - lastStepUs >= 2500) {
    bool forward = elbowTarget > elbowSteps;
    digitalWrite(DIR_PIN, forward ? HIGH : LOW);
    digitalWrite(STEP_PIN, HIGH);
    delayMicroseconds(5);
    digitalWrite(STEP_PIN, LOW);
    elbowSteps += forward ? 1 : -1;
    lastStepUs = micros();
  }
  digitalWrite(LED_BUILTIN, elbowSteps != elbowTarget);
}

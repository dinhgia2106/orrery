// Reference solution: one revolution in 1/16 microsteps (MS1, MS2, MS3 tied high: 3200 microsteps), then hold.
const int STEP_PIN = 3;
const int DIR_PIN = 4;

void setup() {
  pinMode(STEP_PIN, OUTPUT);
  pinMode(DIR_PIN, OUTPUT);
  digitalWrite(DIR_PIN, HIGH);
  delay(10);
  for (int i = 0; i < 3200; i++) {
    digitalWrite(STEP_PIN, HIGH);
    delayMicroseconds(5);
    digitalWrite(STEP_PIN, LOW);
    delayMicroseconds(995);
  }
}

void loop() {}

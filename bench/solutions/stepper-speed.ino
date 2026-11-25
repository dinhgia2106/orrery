// Reference solution: the NEMA 17 turns continuously at 60 rpm: 200 full steps per second, one every 5 ms.
const int STEP_PIN = 3;
const int DIR_PIN = 4;
unsigned long next = 0;

void setup() {
  pinMode(STEP_PIN, OUTPUT);
  pinMode(DIR_PIN, OUTPUT);
  digitalWrite(DIR_PIN, HIGH);
  next = micros();
}

void loop() {
  if ((long)(micros() - next) >= 0) {
    digitalWrite(STEP_PIN, HIGH);
    delayMicroseconds(5);
    digitalWrite(STEP_PIN, LOW);
    next += 5000;
  }
}

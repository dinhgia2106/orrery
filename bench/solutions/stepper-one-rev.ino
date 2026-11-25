// Reference solution: one revolution (200 full steps) through an A4988 on STEP D3 / DIR D4, then hold.
const int STEP_PIN = 3;
const int DIR_PIN = 4;

void setup() {
  pinMode(STEP_PIN, OUTPUT);
  pinMode(DIR_PIN, OUTPUT);
  digitalWrite(DIR_PIN, HIGH);
  delay(10);
  for (int i = 0; i < 200; i++) {
    digitalWrite(STEP_PIN, HIGH);
    delayMicroseconds(5);
    digitalWrite(STEP_PIN, LOW);
    delay(5);
  }
}

void loop() {}

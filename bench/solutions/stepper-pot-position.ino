// Reference solution: the NEMA 17 (A4988, STEP D3, DIR D4, full steps) follows the pot on A0: pot 0 is the
// power-up position, pot 1 is half a turn (100 steps) from it.
const int STEP_PIN = 3;
const int DIR_PIN = 4;
long position = 0; // steps from power-up

void setup() {
  pinMode(STEP_PIN, OUTPUT);
  pinMode(DIR_PIN, OUTPUT);
}

void loop() {
  long target = (analogRead(A0) * 100L + 511) / 1023;
  if (target == position) return;
  bool up = target > position;
  digitalWrite(DIR_PIN, up ? HIGH : LOW);
  delayMicroseconds(5);
  digitalWrite(STEP_PIN, HIGH);
  delayMicroseconds(5);
  digitalWrite(STEP_PIN, LOW);
  position += up ? 1 : -1;
  delay(3);
}

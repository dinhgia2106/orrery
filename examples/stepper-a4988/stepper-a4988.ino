// Stepper behind an A4988 driver: STEP on D3, DIR on D4. Half a turn forward, half back.
const int STEP_PIN = 3;
const int DIR_PIN = 4;
const int STEPS_PER_REV = 200;

void move(int steps, bool forward, unsigned int usPerStep) {
  digitalWrite(DIR_PIN, forward ? HIGH : LOW);
  for (int i = 0; i < steps; i++) {
    digitalWrite(STEP_PIN, HIGH);
    delayMicroseconds(5);
    digitalWrite(STEP_PIN, LOW);
    delayMicroseconds(usPerStep);
  }
}

void setup() {
  pinMode(STEP_PIN, OUTPUT);
  pinMode(DIR_PIN, OUTPUT);
  Serial.begin(115200);
}

void loop() {
  move(STEPS_PER_REV / 2, true, 2000);
  Serial.println("forward 180 deg");
  delay(300);
  move(STEPS_PER_REV / 2, false, 2000);
  Serial.println("back 180 deg");
  delay(300);
}

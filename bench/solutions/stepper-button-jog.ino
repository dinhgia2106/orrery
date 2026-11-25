// Reference solution: each press of the button on D2 turns the NEMA 17 a quarter turn (50 full steps),
// always the same way. A4988 on STEP D3 / DIR D4.
const int STEP_PIN = 3;
const int DIR_PIN = 4;
const int BUTTON = 2;
const unsigned long DEBOUNCE_MS = 20;

int lastReading = HIGH;
int stableState = HIGH;
unsigned long changedAt = 0;

void setup() {
  pinMode(STEP_PIN, OUTPUT);
  pinMode(DIR_PIN, OUTPUT);
  pinMode(BUTTON, INPUT_PULLUP);
  digitalWrite(DIR_PIN, HIGH);
}

void quarterTurn() {
  for (int i = 0; i < 50; i++) {
    digitalWrite(STEP_PIN, HIGH);
    delayMicroseconds(5);
    digitalWrite(STEP_PIN, LOW);
    delay(4);
  }
}

void loop() {
  int reading = digitalRead(BUTTON);
  if (reading != lastReading) {
    changedAt = millis();
    lastReading = reading;
  }
  if (millis() - changedAt > DEBOUNCE_MS && reading != stableState) {
    stableState = reading;
    if (stableState == LOW) quarterTurn();
  }
}

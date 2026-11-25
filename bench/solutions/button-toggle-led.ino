// Reference solution: a debounced button on D2 (INPUT_PULLUP) toggles an LED on D8 (220 ohm in series).
const int BUTTON = 2;
const int LED = 8;
const unsigned long DEBOUNCE_MS = 20;

bool ledOn = false;
int lastReading = HIGH;
int stableState = HIGH;
unsigned long changedAt = 0;

void setup() {
  pinMode(BUTTON, INPUT_PULLUP);
  pinMode(LED, OUTPUT);
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
      ledOn = !ledOn;
      digitalWrite(LED, ledOn ? HIGH : LOW);
    }
  }
}

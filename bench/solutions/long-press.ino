// Reference solution: a short press (released within 0.5 s) toggles the LED on D8; holding 1 s turns it off,
// and the release that follows does nothing. Button on D2 with INPUT_PULLUP, debounced.
const int BUTTON = 2;
const int LED = 8;
const unsigned long DEBOUNCE_MS = 20;

int lastReading = HIGH;
int stableState = HIGH;
unsigned long changedAt = 0;
unsigned long pressedAt = 0;
bool longHandled = false;
bool ledOn = false;

void setLed(bool on) {
  ledOn = on;
  digitalWrite(LED, on ? HIGH : LOW);
}

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
      pressedAt = millis();
      longHandled = false;
    } else if (!longHandled && millis() - pressedAt < 500) {
      setLed(!ledOn);
    }
  }
  if (stableState == LOW && !longHandled && millis() - pressedAt >= 1000) {
    longHandled = true;
    setLed(false);
  }
}

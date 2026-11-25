// Reference solution, board 1: a debounced button on D2 sends 't' over serial (TX D1) on every press.
const int BUTTON = 2;
const unsigned long DEBOUNCE_MS = 20;

int lastReading = HIGH;
int stableState = HIGH;
unsigned long changedAt = 0;

void setup() {
  pinMode(BUTTON, INPUT_PULLUP);
  Serial.begin(9600);
}

void loop() {
  int reading = digitalRead(BUTTON);
  if (reading != lastReading) {
    changedAt = millis();
    lastReading = reading;
  }
  if (millis() - changedAt > DEBOUNCE_MS && reading != stableState) {
    stableState = reading;
    if (stableState == LOW) Serial.write('t');
  }
}

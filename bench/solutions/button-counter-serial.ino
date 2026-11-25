// Reference solution: a debounced button on D2 counts presses and prints "count: n" on each.
const int BUTTON = 2;
const unsigned long DEBOUNCE_MS = 20;

int lastReading = HIGH;
int stableState = HIGH;
unsigned long changedAt = 0;
unsigned int count = 0;

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
    if (stableState == LOW) {
      count++;
      Serial.print("count: ");
      Serial.println(count);
    }
  }
}

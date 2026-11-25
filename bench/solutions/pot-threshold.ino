// Reference solution: the LED on D8 turns on above 3.0 V on the pot wiper (A0) and off below 2.0 V; in
// between it keeps its state (hysteresis).
const int LED = 8;
bool on = false;

void setup() {
  pinMode(LED, OUTPUT);
}

void loop() {
  long mv = analogRead(A0) * 5000L / 1023;
  if (mv > 3000) on = true;
  else if (mv < 2000) on = false;
  digitalWrite(LED, on ? HIGH : LOW);
  delay(5);
}

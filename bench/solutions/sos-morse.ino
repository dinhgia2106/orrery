// Reference solution: SOS on the L LED. Dot 200 ms, dash 600 ms, 200 ms between marks, 600 ms between
// letters, 1400 ms between repeats.
const int DOT = 200;

void mark(int ms, int gap) {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(ms);
  digitalWrite(LED_BUILTIN, LOW);
  delay(gap);
}

void letter(int ms) {
  mark(ms, DOT);
  mark(ms, DOT);
  mark(ms, 0);
}

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  letter(DOT);
  delay(3 * DOT);
  letter(3 * DOT);
  delay(3 * DOT);
  letter(DOT);
  delay(7 * DOT);
}

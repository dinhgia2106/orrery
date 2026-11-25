// Reference solution: green 3 s, yellow 1 s, red 3 s, repeat. LEDs on D2 (red), D3 (yellow), D4 (green).
const int RED = 2, YELLOW = 3, GREEN = 4;

void show(int pin, unsigned long ms) {
  digitalWrite(RED, pin == RED);
  digitalWrite(YELLOW, pin == YELLOW);
  digitalWrite(GREEN, pin == GREEN);
  delay(ms);
}

void setup() {
  pinMode(RED, OUTPUT);
  pinMode(YELLOW, OUTPUT);
  pinMode(GREEN, OUTPUT);
}

void loop() {
  show(GREEN, 3000);
  show(YELLOW, 1000);
  show(RED, 3000);
}

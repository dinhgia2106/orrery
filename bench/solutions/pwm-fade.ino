// Reference solution: an LED on D9 (220 ohm) fades from off to full over 1 s and back over 1 s.
const int LED = 9;

void setup() {
  pinMode(LED, OUTPUT);
}

void loop() {
  for (int i = 0; i <= 255; i++) {
    analogWrite(LED, i);
    delayMicroseconds(3906); // 1 s / 256 steps
  }
  for (int i = 255; i >= 0; i--) {
    analogWrite(LED, i);
    delayMicroseconds(3906);
  }
}

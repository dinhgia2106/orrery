// Reference solution: the SG90 on D9 sweeps 0 -> 180 degrees in 3 s and back in 3 s, at a constant speed.
#include <Servo.h>

Servo servo;
const unsigned long PERIOD_MS = 6000;

void setup() {
  servo.write(0);
  servo.attach(9);
}

void loop() {
  unsigned long t = millis() % PERIOD_MS;
  unsigned long us = t < PERIOD_MS / 2 ? t : PERIOD_MS - t; // 0..3000 ms up, then down
  servo.writeMicroseconds(544 + (us * (2400 - 544)) / 3000);
  delay(5);
}

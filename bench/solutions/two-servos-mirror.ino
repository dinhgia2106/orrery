// Reference solution: the pot on A0 sets servo1 (D9) from 0 to 180 degrees and servo2 (D10) to the mirror
// angle, 180 minus that.
#include <Servo.h>

Servo s1, s2;

void setup() {
  s1.attach(9);
  s2.attach(10);
}

void loop() {
  int a = map(analogRead(A0), 0, 1023, 0, 180);
  s1.write(a);
  s2.write(180 - a);
  delay(15);
}

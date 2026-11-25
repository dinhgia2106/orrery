// Reference solution: pot "panpot" (A0) sets the pan servo on D9, pot "tiltpot" (A1) the tilt servo on D10,
// each over 0..180 degrees; the assembly maps them to -90..90 degrees of pan and 0..60 degrees of tilt.
#include <Servo.h>

Servo pan, tilt;

void setup() {
  pan.attach(9);
  tilt.attach(10);
}

void loop() {
  pan.write(map(analogRead(A0), 0, 1023, 0, 180));
  tilt.write(map(analogRead(A1), 0, 1023, 0, 180));
  delay(15);
}

// Reference solution: a potentiometer on A0 sets an SG90 on D9 from 0 to 180 degrees.
#include <Servo.h>

Servo servo;

void setup() {
  servo.attach(9);
}

void loop() {
  servo.write(map(analogRead(A0), 0, 1023, 0, 180));
  delay(15);
}

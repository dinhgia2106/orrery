// Reference solution: six SG90s on D3, D5, D6, D9, D10, D11 move together between 0 and 180 degrees every
// second. They are powered from a 5 V bench supply whose ground is joined to the Uno's.
#include <Servo.h>

const int PINS[6] = {3, 5, 6, 9, 10, 11};
Servo servos[6];

void all(int deg) {
  for (int i = 0; i < 6; i++) servos[i].write(deg);
}

void setup() {
  for (int i = 0; i < 6; i++) {
    servos[i].write(0);
    servos[i].attach(PINS[i]);
  }
}

void loop() {
  all(0);
  delay(1000);
  all(180);
  delay(1000);
}

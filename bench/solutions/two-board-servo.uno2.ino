// Reference solution, board 2: read lines of 0..1023 on RX (D0) and set the SG90 on D9 to 0..180 degrees.
#include <Servo.h>

Servo servo;
long value = 0;
bool any = false;

void setup() {
  Serial.begin(9600);
  servo.attach(9);
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c >= '0' && c <= '9') {
      value = value * 10 + (c - '0');
      any = true;
    } else if (c == '\n') {
      if (any && value <= 1023) servo.write(map(value, 0, 1023, 0, 180));
      value = 0;
      any = false;
    }
  }
}

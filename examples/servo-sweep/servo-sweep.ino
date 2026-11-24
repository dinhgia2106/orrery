// Servo sweep: a hobby servo on D9 swings 0–180°, the D13 LED marks the direction.
#include <Servo.h>

Servo base;

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  base.attach(9);
  Serial.begin(115200);
  Serial.println("servo sweep");
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  for (int a = 0; a <= 180; a += 2) {
    base.write(a);
    delay(15);
  }
  digitalWrite(LED_BUILTIN, LOW);
  for (int a = 180; a >= 0; a -= 2) {
    base.write(a);
    delay(15);
  }
  Serial.println("sweep done");
}

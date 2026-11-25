// Reference solution: a line with a whole number 0..180 moves the SG90 on D9 there and is answered
// "angle <n>"; anything else is answered "error" and the servo stays.
#include <Servo.h>

Servo servo;
String line;

void setup() {
  Serial.begin(9600);
  servo.attach(9);
}

void handle(String s) {
  s.trim();
  bool digits = s.length() > 0 && s.length() <= 3;
  for (unsigned int i = 0; i < s.length(); i++) if (!isDigit(s[i])) digits = false;
  int n = digits ? s.toInt() : -1;
  if (n < 0 || n > 180) {
    Serial.println("error");
    return;
  }
  servo.write(n);
  Serial.print("angle ");
  Serial.println(n);
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      handle(line);
      line = "";
    } else {
      line += c;
    }
  }
}

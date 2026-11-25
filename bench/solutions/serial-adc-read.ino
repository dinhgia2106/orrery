// Reference solution: the line "read" is answered with analogRead(A0) as a decimal line.
String line;

void setup() {
  Serial.begin(9600);
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      line.trim();
      if (line == "read") Serial.println(analogRead(A0));
      line = "";
    } else {
      line += c;
    }
  }
}

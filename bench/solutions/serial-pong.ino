// Reference solution: print "ready" once, then answer every line "ping" with a line "pong" (9600 baud).
String line;

void setup() {
  Serial.begin(9600);
  Serial.println("ready");
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      line.trim();
      if (line == "ping") Serial.println("pong");
      line = "";
    } else {
      line += c;
    }
  }
}

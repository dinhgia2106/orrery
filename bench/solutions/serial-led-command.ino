// Reference solution: lines "on", "off", "toggle" drive the L LED and are answered "ok"; anything else "error".
String line;

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(9600);
}

void handle(String cmd) {
  cmd.trim();
  if (cmd == "on") digitalWrite(LED_BUILTIN, HIGH);
  else if (cmd == "off") digitalWrite(LED_BUILTIN, LOW);
  else if (cmd == "toggle") digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN));
  else {
    Serial.println("error");
    return;
  }
  Serial.println("ok");
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

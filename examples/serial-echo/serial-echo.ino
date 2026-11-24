// Board B of the two-board template: reads lines on its RX pin (D0), toggles the L LED for each one
// and prints what it got.
String line;
bool led = false;

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      led = !led;
      digitalWrite(LED_BUILTIN, led);
      Serial.print("got: ");
      Serial.println(line);
      line = "";
    } else if (c != '\r') {
      line += c;
    }
  }
}

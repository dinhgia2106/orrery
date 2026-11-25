// Reference solution, board 2: every 't' received on RX (D0) toggles the on-board L LED.
bool on = false;

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  if (Serial.available() && Serial.read() == 't') {
    on = !on;
    digitalWrite(LED_BUILTIN, on ? HIGH : LOW);
  }
}

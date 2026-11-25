// Reference solution, board 1: send the pot reading on A0 as a line of text (0..1023) every 20 ms.
void setup() {
  Serial.begin(9600);
}

void loop() {
  Serial.println(analogRead(A0));
  delay(20);
}

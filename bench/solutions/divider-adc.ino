// Reference solution: print the voltage on A0 in millivolts once per second as "mV=<n>".
void setup() {
  Serial.begin(9600);
}

void loop() {
  long mv = analogRead(A0) * 5000L / 1023;
  Serial.print("mV=");
  Serial.println(mv);
  delay(1000);
}

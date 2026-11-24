// Board A of the two-board template: sends "ping <n>" over its TX pin (D1) every 500 ms.
unsigned long n = 0;

void setup() {
  Serial.begin(9600);
}

void loop() {
  Serial.print("ping ");
  Serial.println(n++);
  delay(500);
}

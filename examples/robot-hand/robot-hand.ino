// Five-finger tendon hand: the pot on A0 closes all fingers together, the button on D2 turns the wrist.
// Servos: thumb D3, index D5, middle D6, ring D9, little D10, wrist D11 (powered from a 5 V supply,
// ground shared with the Uno).
#include <Servo.h>

const int FINGER_PINS[5] = {3, 5, 6, 9, 10};
const int WRIST_PIN = 11;
const int BUTTON_PIN = 2;
const int POT_PIN = A0;

Servo fingers[5];
Servo wrist;
bool wristTurned = false;
bool lastButton = HIGH;   // debounced level
bool lastReading = HIGH;  // raw level
unsigned long lastChangeMs = 0;

void setup() {
  for (int i = 0; i < 5; i++) fingers[i].attach(FINGER_PINS[i]);
  wrist.attach(WRIST_PIN);
  wrist.write(90);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  Serial.begin(115200);
  Serial.println("hand ready: turn the pot to grip, press the button to turn the wrist");
}

void loop() {
  int grip = map(analogRead(POT_PIN), 0, 1023, 0, 180);
  for (int i = 0; i < 5; i++) fingers[i].write(grip);

  // the Omron B3F bounces for up to 5 ms: accept a level once it has been stable for 10 ms
  bool reading = digitalRead(BUTTON_PIN);
  if (reading != lastReading) {
    lastReading = reading;
    lastChangeMs = millis();
  }
  if (millis() - lastChangeMs >= 10 && reading != lastButton) {
    lastButton = reading;
    if (lastButton == LOW) {
      wristTurned = !wristTurned;
      wrist.write(wristTurned ? 180 : 90);
      Serial.println(wristTurned ? "wrist -> 180" : "wrist -> 90");
    }
  }
  delay(5);
}

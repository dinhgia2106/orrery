/**
 * A firmware image that needs no compiler: Blink on D13 (PB5), hand-assembled for the ATmega328P.
 * It toggles the LED every ~0.5 s using a 3-level busy-wait loop. Each word is annotated.
 */
export const BLINK_ASM_WORDS = [
  0xe200, //  0  ldi  r16, 0x20        ; PB5 mask
  0xb904, //  1  out  DDRB, r16        ; PB5 = output
  0xb905, //  2  loop: out PORTB, r16  ; LED on
  0xd004, //  3  rcall delay
  0x2711, //  4  eor  r17, r17         ; r17 = 0
  0xb915, //  5  out  PORTB, r17       ; LED off
  0xd001, //  6  rcall delay
  0xcffa, //  7  rjmp loop
  0xe229, //  8  delay: ldi r18, 41
  0xe030, //  9  d1: ldi r19, 0        ; 256 iterations
  0xe040, // 10  d2: ldi r20, 0
  0x954a, // 11  d3: dec r20
  0xf7f1, // 12  brne d3
  0x953a, // 13  dec  r19
  0xf7d9, // 14  brne d2
  0x952a, // 15  dec  r18
  0xf7c1, // 16  brne d1
  0x9508, // 17  ret
];

export function blinkProgram(): Uint16Array {
  const prog = new Uint16Array(0x4000);
  prog.set(BLINK_ASM_WORDS);
  return prog;
}

// Real parts behind each simulated part: what to buy, and the datasheet figures the models use.
// Every number here comes from the source named next to it. Values marked `approx` are not in
// any datasheet we could read and are shown in the UI as approximations.

export interface Source {
  title: string;
  url: string;
}

export interface CatalogItem {
  key: string;
  name: string;
  manufacturer: string;
  /** Manufacturer part number / order code — what to search for at a distributor. */
  mpn: string;
  url: string;
  datasheet: Source;
  /** One-line facts for the BOM and the inspector. */
  specs: string[];
  /** Things to know before buying or wiring it. */
  notes?: string[];
}

export const SOURCES = {
  unoDatasheet: { title: 'Arduino UNO R3 datasheet (A000066)', url: 'https://docs.arduino.cc/resources/datasheets/A000066-datasheet.pdf' },
  unoSchematic: { title: 'Arduino UNO R3 schematic', url: 'https://docs.arduino.cc/resources/schematics/A000066-schematics.pdf' },
  sg90: { title: 'TowerPro SG90 product page', url: 'https://towerpro.com.tw/product/sg90-7/' },
  sg90Sheet: { title: 'SG90 datasheet compilation (TowerPro SG90 page 2)', url: 'https://www.friendlywire.com/projects/ne555-servo-safe/SG90-datasheet.pdf' },
  servoH: { title: 'Arduino Servo library 1.3.0, Servo.h', url: 'https://github.com/arduino-libraries/Servo/blob/master/src/Servo.h' },
  pololu1182: { title: 'Pololu #1182 A4988 carrier', url: 'https://www.pololu.com/product/1182' },
  a4988: { title: 'Allegro A4988 datasheet', url: 'https://www.allegromicro.com/-/media/files/datasheets/a4988-datasheet.pdf' },
  pololu2267: { title: 'Pololu #2267 stepper motor (SY42STH38-1684A)', url: 'https://www.pololu.com/product/2267' },
  sy42Drawing: { title: 'SY42STH38-1684A specification drawing (Songyang, via Pololu)', url: 'https://www.pololu.com/file/0J714/SY42STH38-1684A.pdf' },
  m328: { title: 'Microchip ATmega328P datasheet (7810D)', url: 'https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf' },
  b3f: { title: 'Omron B3F datasheet', url: 'https://omronfs.omron.com/en_US/ecb/products/pdf/en-b3f.pdf' },
  ptv09: { title: 'Bourns PTV09 datasheet', url: 'https://www.bourns.com/docs/Product-Datasheets/ptv09.pdf' },
  wp7113id: { title: 'Kingbright WP7113ID datasheet', url: 'https://www.kingbrightusa.com/images/catalog/SPEC/WP7113ID.pdf' },
} satisfies Record<string, Source>;

/** Figures the simulation uses, each with its source. Units are in the name. */
export const SPEC = {
  uno: {
    lengthMm: 68.6, // Arduino UNO R3 datasheet / product page
    widthMm: 53.4,
    pcbThicknessMm: 1.6, // approx: common FR4 thickness, not stated in the datasheet
    headerHeightMm: 8.5, // schematic: headers "8x1F-H8.5", "10x1F-H8.5", "6x1F-H8.5"
    usbFuseMa: 500, // schematic: USB polyfuse MF-MSMF050-2 500mA
    /** approx: the datasheet leaves "Maximum Power Consumption" blank ("xx mA"); placeholder estimate. */
    boardMaApprox: 50,
    builtinLedSeriesOhms: 1000, // schematic: L LED (yellow) fed through 1K from an LMV358 buffer on D13
    vinMinV: 7, // datasheet: VIN (barrel jack) 7–12 V recommended
    vinMaxV: 12,
  },
  /** ATmega328P I/O pins at VCC = 5 V (Microchip datasheet 7810D, DC characteristics). */
  m328: {
    pinAbsMaxMa: 40, // DC current per I/O pin 40.0 mA (absolute maximum)
    vilFrac: 0.3, // VIL max 0.3 VCC
    vihFrac: 0.6, // VIH min 0.6 VCC
    vohAt20mA: 4.1, // VOH 4.1 V at IOH = −20 mA  → ~45 Ω source resistance
    volAt20mA: 0.8, // VOL 0.8 V at IOL = 20 mA  → ~40 Ω sink resistance
    pullupMinOhms: 20_000, // RPU 20–50 kΩ
    pullupMaxOhms: 50_000,
  },
  sg90: {
    lengthMm: 23.1, // SG90 datasheet compilation p.2: 23.1 x 12.2 x 29.0 mm
    widthMm: 12.2,
    heightMm: 29.0,
    tabSpanMm: 32.3, // approx: TowerPro table value "E"; the drawing labelling it is not readable
    secPer60Deg: 0.1, // TowerPro: 0.1 s/60° at 4.8 V  → 600 °/s
    stallTorqueKgfCm: 1.8, // TowerPro: 1.8 kg·cm at 4.8 V
    weightG: 9,
    /**
     * approx: TowerPro publishes no current spec. Its site answers "about 0.5A – 2A" for operating current;
     * the model counts the lower end while the horn moves and 0 when idle (idle current is not published).
     */
    movingMaApprox: 500,
  },
  servoLib: { minUs: 544, maxUs: 2400 }, // Servo.h MIN_PULSE_WIDTH / MAX_PULSE_WIDTH
  a4988: {
    stepHighMinUs: 1, // Allegro datasheet, Logic Interface Timing: tA STEP minimum HIGH pulse width 1 µs
    stepLowMinUs: 1, // tB STEP minimum LOW pulse width 1 µs
    setupNs: 200, // tC setup time, input change to STEP 200 ns
    logicMaMax: 8, // IDD max 8 mA (fPWM < 50 kHz)
    noHeatsinkA: 1, // Pololu #1182: ~1 A per phase without heat sink, 2 A with sufficient cooling
    vmotMinV: 8, // Pololu #1182: motor supply 8–35 V
    vmotMaxV: 35,
    boardMm: [20.32, 15.24] as [number, number], // Pololu #1182 specs: 0.6" × 0.8" (without headers)
    logicHighFrac: 0.7, // VIN(1) min VDD × 0.7
    logicLowFrac: 0.3, // VIN(0) max VDD × 0.3
    vddMinV: 3, // Pololu #1182: logic supply 3–5.5 V
    vddMaxV: 5.5,
    wakeMs: 1, // Allegro: after SLEEP goes high, wait 1 ms before STEP
    ms1PulldownOhms: 100_000, // Allegro / Pololu: MS1 and MS3 100 kΩ pull-down, MS2 50 kΩ
    ms2PulldownOhms: 50_000,
    ms3PulldownOhms: 100_000,
    vmotCapUf: 47, // Pololu #1182: at least 47 µF electrolytic across VMOT and GND
  },
  nema17: {
    stepsPerRev: 200, // Pololu #2267: 1.8° per step
    frameMm: 42.3, // Pololu #2267: 42.3 mm square × 38 mm
    bodyMm: 38,
    shaftDiaMm: 5, // 5 mm "D" shaft
    shaftLenMmApprox: 24, // SY42STH38-1684A drawing: shaft 24 ±1 mm (name kept for existing callers)
    boltSpacingMm: 31, // drawing: 31 ±0.2 mm square, 4-M3, 4.5 mm deep
    boltThread: 'M3',
    boltDepthMm: 4.5,
    pilotDiaMm: 22, // drawing: φ22 (0 / −0.05) pilot boss
    ratedA: 1.68, // 1.68 A per coil
    holdingTorqueKgfCm: 3.7,
    weightG: 285,
    /**
     * approx: the SY42STH38-1684A drawing has a pull-out torque curve (24 V, 1.68 A, half step) only as a
     * graph, so the step rate above which the model loses steps is an estimate, not a value read from it.
     */
    maxStepsPerSecApprox: 1000,
  },
  b3f: {
    bodyMm: 6, // Omron B3F: 6 × 6 mm models
    plungerHeightMm: 4.3, // B3F-1000: plunger height 4.3 mm, operating force 0.98 N, ivory plunger
    bounceMsMax: 5, // Omron B3F: bounce time 5 ms max
    contactOhms: 0.1, // contact resistance 100 mΩ max (initial)
  },
  ptv09: {
    bodyMm: 9, // Bourns PTV09: 9 mm potentiometer
    heightMm: 10, // PTV09A-2: vertical, bushingless, 10 mm height
    shaftLenMm: 20, // order code "20" = 20 mm shaft
    mechanicalAngleDeg: 280, // mechanical angle 280° ±10°
    ohms: 10_000, // resistance code 103
  },
  wp7113id: {
    vfTyp: 1.9, // Kingbright WP7113ID: VF 1.9 V typ / 2.3 V max at IF = 10 mA
    ifMaxMa: 30, // DC forward current 30 mA (absolute maximum)
    lensMm: 5, // T-1 3/4 (5 mm) lamp
  },
};

export const CATALOG: Record<string, CatalogItem> = {
  uno: {
    key: 'uno',
    name: 'Arduino UNO R3',
    manufacturer: 'Arduino',
    mpn: 'A000066',
    url: 'https://store.arduino.cc/products/arduino-uno-rev3',
    datasheet: SOURCES.unoDatasheet,
    specs: ['ATmega328P-PU, 16 MHz', '68.6 × 53.4 mm, 25 g', 'USB polyfuse 500 mA', 'Barrel jack 7–12 V (2.1 × 5.5 mm)'],
    notes: ['The D13 "L" LED is on the board (yellow, 1 kΩ, buffered by an LMV358), so it is not a separate part.'],
  },
  sg90: {
    key: 'sg90',
    name: 'Micro servo 9 g',
    manufacturer: 'TowerPro',
    mpn: 'SG90',
    url: SOURCES.sg90.url,
    datasheet: SOURCES.sg90Sheet,
    specs: ['1.8 kgf·cm stall at 4.8 V', '0.1 s / 60° at 4.8 V', '23.1 × 12.2 × 29.0 mm, 9 g', 'Wires: brown GND, red +, orange signal'],
    notes: [
      'Many clones are sold as "SG90" with different specs; buy from a TowerPro distributor if the numbers matter.',
      'TowerPro gives no current rating (its site says about 0.5–2 A when moving): power it from a separate 5 V supply with a common ground.',
    ],
  },
  resistor: {
    key: 'resistor',
    name: 'Resistor, ¼ W through-hole',
    manufacturer: 'any (value from the inspector)',
    mpn: '—',
    url: 'https://en.wikipedia.org/wiki/Electronic_color_code',
    datasheet: { title: 'E-series values', url: 'https://en.wikipedia.org/wiki/E_series_of_preferred_numbers' },
    specs: ['Generic part: pick the value in the inspector'],
  },
  cap: {
    key: 'cap',
    name: 'Electrolytic capacitor',
    manufacturer: 'any (≥ 47 µF, rated above VMOT)',
    mpn: '—',
    url: SOURCES.pololu1182.url,
    datasheet: SOURCES.pololu1182,
    specs: ['Pololu: at least 47 µF across VMOT and GND, close to the driver'],
  },
  psu: {
    key: 'psu',
    name: 'Bench power supply',
    manufacturer: 'any adjustable DC supply',
    mpn: '—',
    url: SOURCES.pololu1182.url,
    datasheet: SOURCES.pololu1182,
    specs: ['Motor side of the A4988: 8–35 V', 'Servos: 4.8–6 V'],
  },
  a4988: {
    key: 'a4988',
    name: 'A4988 stepper driver carrier',
    manufacturer: 'Pololu',
    mpn: '1182',
    url: SOURCES.pololu1182.url,
    datasheet: SOURCES.a4988,
    specs: ['Motor supply 8–35 V, logic 3–5.5 V', '~1 A/phase without heat sink, 2 A with cooling', 'STEP pulse ≥ 1 µs high and low'],
    notes: ['Set the current limit with the trimmer before connecting the motor.'],
  },
  nema17: {
    key: 'nema17',
    name: 'NEMA 17 stepper, bipolar 4-wire, 200 steps/rev',
    manufacturer: 'SOYO (sold by Pololu as #2267)',
    mpn: 'SY42STH38-1684A',
    url: SOURCES.pololu2267.url,
    datasheet: SOURCES.pololu2267,
    specs: ['42.3 mm square × 38 mm, 285 g', '1.68 A/coil, 1.65 Ω, 3.2 mH', '3.7 kgf·cm holding torque', '5 mm D shaft'],
    notes: ['Set the A4988 current limit to ~1 A without a heat sink (the motor is rated 1.68 A).'],
  },
  b3f: {
    key: 'b3f',
    name: 'Tactile switch 6 × 6 mm',
    manufacturer: 'Omron',
    mpn: 'B3F-1000',
    url: SOURCES.b3f.url,
    datasheet: SOURCES.b3f,
    specs: ['0.98 N operating force', '4.3 mm plunger height', 'Bounce ≤ 5 ms', '1–50 mA, 3–24 VDC'],
    notes: ['Contacts bounce for up to 5 ms: debounce in firmware.'],
  },
  ptv09: {
    key: 'ptv09',
    name: 'Potentiometer 10 kΩ linear, 9 mm',
    manufacturer: 'Bourns',
    mpn: 'PTV09A-2020F-B103',
    url: SOURCES.ptv09.url,
    datasheet: SOURCES.ptv09,
    specs: ['10 kΩ ±20 %, linear (B) taper', 'Vertical, 10 mm high, 20 mm flat shaft', '280° mechanical angle'],
  },
  wp7113id: {
    key: 'wp7113id',
    name: 'LED 5 mm red, diffused',
    manufacturer: 'Kingbright',
    mpn: 'WP7113ID',
    url: SOURCES.wp7113id.url,
    datasheet: SOURCES.wp7113id,
    specs: ['VF 1.9 V typ / 2.3 V max at 10 mA', 'IF 30 mA max'],
    notes: ['Needs a series resistor: (5 V − 1.9 V) / 330 Ω ≈ 9.4 mA.'],
  },
};

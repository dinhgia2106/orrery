import {
  AVRADC,
  AVRIOPort,
  AVRTimer,
  AVRUSART,
  CPU,
  PinState,
  adcConfig,
  avrInstruction,
  portBConfig,
  portCConfig,
  portDConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  usart0Config,
} from 'avr8js';

export const CLOCK_HZ = 16_000_000;

export const DIGITAL_PINS = [
  'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13',
] as const;
export const ANALOG_PINS = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5'] as const;
export type PinName = (typeof DIGITAL_PINS)[number] | (typeof ANALOG_PINS)[number];

type PortKey = 'B' | 'C' | 'D';

/** Arduino Uno pin -> ATmega328P port bit (D0–D7 = PORTD, D8–D13 = PORTB, A0–A5 = PORTC). */
export function pinLocation(pin: PinName): { port: PortKey; bit: number } {
  if (pin[0] === 'A') return { port: 'C', bit: Number(pin.slice(1)) };
  const n = Number(pin.slice(1));
  return n < 8 ? { port: 'D', bit: n } : { port: 'B', bit: n - 8 };
}

/** PWM-capable pins on the Uno (marked ~ on the board). */
export const PWM_PINS: PinName[] = ['D3', 'D5', 'D6', 'D9', 'D10', 'D11'];

export type PinListener = (pin: PinName, high: boolean, timeSec: number) => void;

/** An ATmega328P Arduino Uno running real firmware, cycle by cycle, via avr8js. */
export class ArduinoUno {
  readonly cpu: CPU;
  readonly ports: Record<PortKey, AVRIOPort>;
  readonly adc: AVRADC;
  readonly usart: AVRUSART;
  readonly timers: AVRTimer[];
  private readonly listeners = new Set<PinListener>();
  private readonly level = new Map<PinName, boolean>();
  private readonly serialListeners = new Set<(text: string) => void>();

  constructor(program: Uint16Array) {
    this.cpu = new CPU(program);
    this.timers = [timer0Config, timer1Config, timer2Config].map((c) => new AVRTimer(this.cpu, c));
    this.ports = {
      B: new AVRIOPort(this.cpu, portBConfig),
      C: new AVRIOPort(this.cpu, portCConfig),
      D: new AVRIOPort(this.cpu, portDConfig),
    };
    this.adc = new AVRADC(this.cpu, adcConfig);
    this.usart = new AVRUSART(this.cpu, usart0Config, CLOCK_HZ);
    this.usart.onByteTransmit = (byte) => {
      const ch = String.fromCharCode(byte);
      this.serialListeners.forEach((l) => l(ch));
    };
    for (const key of ['B', 'C', 'D'] as PortKey[]) {
      this.ports[key].addListener(() => this.scan(key));
    }
  }

  /** Simulated time in seconds since reset. */
  get time(): number {
    return this.cpu.cycles / CLOCK_HZ;
  }

  onPin(listener: PinListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onSerial(listener: (text: string) => void): () => void {
    this.serialListeners.add(listener);
    return () => this.serialListeners.delete(listener);
  }

  /** Current output level of a pin (true = driven high). */
  isHigh(pin: PinName): boolean {
    const { port, bit } = pinLocation(pin);
    return this.ports[port].pinState(bit) === PinState.High;
  }

  /** Drive an input pin from outside (button, sensor output). */
  setDigitalInput(pin: PinName, high: boolean): void {
    const { port, bit } = pinLocation(pin);
    this.ports[port].setPin(bit, high);
  }

  /** Set the voltage seen by an analog input (0–5 V). */
  setAnalogInput(pin: (typeof ANALOG_PINS)[number], volts: number): void {
    const ch = Number(pin.slice(1));
    this.adc.channelValues[ch] = Math.min(5, Math.max(0, volts));
  }

  /** Run the CPU for a span of simulated time. */
  run(seconds: number): void {
    const end = this.cpu.cycles + Math.round(seconds * CLOCK_HZ);
    while (this.cpu.cycles < end) {
      avrInstruction(this.cpu);
      this.cpu.tick();
    }
  }

  private scan(port: PortKey): void {
    const t = this.time;
    const pins = port === 'B' ? DIGITAL_PINS.slice(8) : port === 'D' ? DIGITAL_PINS.slice(0, 8) : ANALOG_PINS;
    pins.forEach((pin, bit) => {
      const high = this.ports[port].pinState(bit) === PinState.High;
      if (this.level.get(pin) !== high) {
        this.level.set(pin, high);
        this.listeners.forEach((l) => l(pin, high, t));
      }
    });
  }
}

declare function setTimeout(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): number;
declare function clearTimeout(handle: number | undefined): void;
declare function setInterval(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): number;
declare function clearInterval(handle: number | undefined): void;
declare function queueMicrotask(callback: () => void): void;
declare function btoa(text: string): string;
declare function atob(text: string): string;
declare var crypto: { getRandomValues<T extends ArrayBufferView>(array: T): T; randomUUID(): string };
declare var console: { log(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void; info(...args: unknown[]): void };
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean });
  decode(input?: ArrayBufferView | ArrayBuffer): string;
}

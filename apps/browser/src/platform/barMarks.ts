export type BarFieldMarks = {
  change(variant: string, eventCount: number, length: number): void;
  write(variant: string, length: number, nativeLength: number): void;
  suggestions(ms: number, textLength: number): void;
  repair(variant: string, letters: number, at: number): void;
  rows(pointerOver: boolean, held: boolean, shown: number): void;
  field(event: string, variant: string, tag: number | null): void;
};

export const barFieldMarks: BarFieldMarks = { change() {}, write() {}, suggestions() {}, repair() {}, rows() {}, field() {} };

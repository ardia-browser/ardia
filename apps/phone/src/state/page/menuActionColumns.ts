export type CaptionMeasure = { fontSize: number; fontScale: number; advance: number; maxLines: number };

const widthOf = (text: string, measure: CaptionMeasure) => text.length * measure.fontSize * measure.fontScale * measure.advance;

export function captionLines(label: string, width: number, measure: CaptionMeasure): number {
  const space = widthOf(" ", measure);
  let lines = 1;
  let line = 0;
  for (const word of label.split(" ")) {
    const wordWidth = widthOf(word, measure);
    if (wordWidth > width) return Number.POSITIVE_INFINITY;
    const extended = line === 0 ? wordWidth : line + space + wordWidth;
    if (extended <= width) {
      line = extended;
      continue;
    }
    lines += 1;
    line = wordWidth;
  }
  return lines;
}

export function evenColumnCounts(count: number): number[] {
  const counts: number[] = [];
  for (let columns = count; columns >= 1; columns--) if (count % columns === 0) counts.push(columns);
  return counts;
}

export const tileWidth = (available: number, gap: number, columns: number) => (available - gap * (columns - 1)) / columns;

export function actionColumns(labels: readonly string[], available: number, gap: number, measure: CaptionMeasure): number {
  for (const columns of evenColumnCounts(labels.length)) {
    const width = tileWidth(available, gap, columns);
    if (labels.every((label) => captionLines(label, width, measure) <= measure.maxLines)) return columns;
  }
  return 1;
}

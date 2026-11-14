import { pdfDocument, PdfPage, wrapped, type PdfFont } from "./pdf.ts";
import { base64, grayscalePng } from "./png.ts";
import { qrCode } from "./qr.ts";

export const KIT_PDF_NAME = "Ardia Recovery Kit.pdf";
export const KIT_TEXT_NAME = "Ardia Recovery Kit.txt";
export const HIDDEN_WORDS: readonly string[] = Array(24).fill("••••••");

const INTRO = "If you don’t have access to the computer on which you first turned on sync, you can still get your synced data on another computer:";
const STEPS = ["Open Ardia › Settings › Sync, and choose the same sync folder.", "Click Enter Recovery Phrase.", "Paste the 24 words below."];
const WARNING =
  "Keep this kit somewhere safe, like a password manager or a printed copy. Anyone with these words and your sync folder can read your synced data. Ardia can’t recover the words for you: there’s no server and no other copy.";
const CODE_TITLE = "Moving to a new computer?";
const CODE_NOTE = "Scan this code with your phone’s camera to copy the words, then enter them on the new computer.";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const PAGE = { width: 612, height: 792, margin: 60 } as const;
const INK = 0.1;
const GREY = 0.4;
const QR_SCALE = 8;
const QR_BORDER = 1;

type KitPage = Pick<PdfPage, "text" | "rect" | "roundedRect">;

export const createdDate = (date: Date) => `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;

export function kitText(words: readonly string[], created: Date, device: string): string {
  const lines = ["Ardia Recovery Kit", `Created ${createdDate(created)} on ${device}`, "", INTRO, ""];
  lines.push(...STEPS.map((step, i) => `${i + 1}. ${step}`));
  lines.push("", "Recovery phrase:", "");
  lines.push(...words.map((word, i) => `${String(i + 1).padStart(2, " ")}. ${word}`));
  lines.push("", WARNING, "");
  return lines.join("\n");
}

function drawKit(page: KitPage, words: readonly string[], created: Date, device: string): void {
  const width = PAGE.width - PAGE.margin * 2;
  let y = 64;
  const text = (content: string, font: PdfFont, size: number, gray: number, spacing = 8, x: number = PAGE.margin, boxWidth = width) => {
    const lines = wrapped(content, font, size, boxWidth);
    const lineHeight = size * 1.2 + 3;
    lines.forEach((line, i) => page.text(line, x, y + i * lineHeight, font, size, gray));
    y += lines.length * lineHeight - 3 + spacing;
  };
  text("Ardia Recovery Kit", "bold", 26, INK, 4);
  text(`Created ${createdDate(created)} on ${device}`, "regular", 12, GREY, 26);
  text(INTRO, "regular", 13, INK, 10);
  STEPS.forEach((step, i) => text(`${i + 1}.  ${step}`, "regular", 13, INK, 4, PAGE.margin + 8, width - 8));
  y += 18;

  const box = { x: PAGE.margin, top: y, width, height: 6 * 26 + 30 };
  page.roundedRect(box.x, box.top, box.width, box.height, 12, 0.96, 0.82);
  const column = (box.width - 36) / 4;
  words.forEach((word, i) => {
    const x = box.x + 18 + Math.floor(i / 6) * column;
    const rowTop = box.top + 15 + (i % 6) * 26;
    const label = String(i + 1);
    page.text(label, x + 14 - label.length * 5.56, rowTop + 4, "regular", 10, GREY);
    page.text(word, x + 20, rowTop, "mono", 14, INK);
  });
  y = box.top + box.height + 22;

  const side = 112;
  const code = qrCode(words.join(" "));
  const module = side / (code.size + 2);
  page.rect(PAGE.margin, y, side, side, 1);
  for (let row = 0; row < code.size; row++) {
    for (let col = 0; col < code.size; col++) if (code.dark(col, row)) page.rect(PAGE.margin + (col + 1) * module, y + (row + 1) * module, module + 0.05, module + 0.05, 0);
  }
  const captionTop = y;
  y += 18;
  text(CODE_TITLE, "bold", 12, INK, 4, PAGE.margin + side + 18, width - side - 18);
  text(CODE_NOTE, "regular", 12, GREY, 8, PAGE.margin + side + 18, width - side - 18);
  y = Math.max(y, captionTop + side) + 26;
  text(WARNING, "regular", 11, GREY);
}

export function kitPdf(words: readonly string[], created: Date, device: string): Uint8Array {
  const page = new PdfPage(PAGE.width, PAGE.height);
  drawKit(page, words, created, device);
  return pdfDocument(page, "Ardia Recovery Kit");
}

const SVG_FONTS: Record<PdfFont, string> = {
  regular: `font-family="Helvetica, Arial, 'Liberation Sans', sans-serif"`,
  bold: `font-family="Helvetica, Arial, 'Liberation Sans', sans-serif" font-weight="bold"`,
  mono: `font-family="'Courier New', Courier, 'Liberation Mono', monospace" font-weight="bold"`,
};
const shade = (gray: number) => {
  const level = Math.round(Math.min(1, Math.max(0, gray)) * 255);
  return `rgb(${level},${level},${level})`;
};
const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const svgNumber = (n: number) => (Math.round(n * 100) / 100).toString();

class SvgPage implements KitPage {
  private readonly parts: string[] = [];

  text(text: string, x: number, top: number, font: PdfFont, size: number, gray: number) {
    this.parts.push(`<text x="${svgNumber(x)}" y="${svgNumber(top + size * 0.93)}" font-size="${svgNumber(size)}" ${SVG_FONTS[font]} fill="${shade(gray)}">${xml(text)}</text>`);
  }

  rect(x: number, top: number, width: number, height: number, gray: number) {
    this.parts.push(`<rect x="${svgNumber(x)}" y="${svgNumber(top)}" width="${svgNumber(width)}" height="${svgNumber(height)}" fill="${shade(gray)}"/>`);
  }

  roundedRect(x: number, top: number, width: number, height: number, radius: number, fill: number, stroke: number) {
    this.parts.push(`<rect x="${svgNumber(x)}" y="${svgNumber(top)}" width="${svgNumber(width)}" height="${svgNumber(height)}" rx="${radius}" fill="${shade(fill)}" stroke="${shade(stroke)}" stroke-width="1"/>`);
  }

  document(width: number): string {
    const height = (width * PAGE.height) / PAGE.width;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgNumber(width)}" height="${svgNumber(height)}" viewBox="0 0 ${PAGE.width} ${PAGE.height}"><rect width="${PAGE.width}" height="${PAGE.height}" fill="#fff"/>${this.parts.join("")}</svg>`;
  }
}

export function kitPreview(width: number, created: Date, device: string): string {
  const page = new SvgPage();
  drawKit(page, HIDDEN_WORDS, created, device);
  return `data:image/svg+xml;base64,${Buffer.from(page.document(width), "utf8").toString("base64")}`;
}

export function qrDataUrl(words: readonly string[]): string {
  const code = qrCode(words.join(" "));
  const side = (code.size + QR_BORDER * 2) * QR_SCALE;
  const pixel = (x: number, y: number) => {
    const mx = Math.floor(x / QR_SCALE) - QR_BORDER;
    const my = Math.floor(y / QR_SCALE) - QR_BORDER;
    return mx >= 0 && my >= 0 && mx < code.size && my < code.size && code.dark(mx, my) ? 0 : 255;
  };
  return `data:image/png;base64,${base64(grayscalePng(side, side, pixel))}`;
}

export const kitBytes = (words: readonly string[], format: "pdf" | "text", device: string): Uint8Array =>
  format === "text" ? Buffer.from(kitText(words, new Date(), device), "utf8") : kitPdf(words, new Date(), device);

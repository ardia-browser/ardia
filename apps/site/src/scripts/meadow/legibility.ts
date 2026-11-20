import type { Program } from "./gl";

export type Tone = "light" | "dark";

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const DAY_INK_LUMINANCE = 0.0068;
const NIGHT_INK_LUMINANCE = 0.8;
const LARGE_TEXT_FLOOR = 3;
const TONE_HYSTERESIS = 1.25;
const SAMPLE_PAD = 6;
const PROBE_WIDTH = 96;
const DARKEST_SHARE = 0.04;
const BRIGHTEST_SHARE = 0.96;
const MIST_CALLS_AT = 3.6;
const MIST_LIFTS_AT = 5;
const MIST_RISE = 0.25;
const MIST_FALL = 0.08;

const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

const visible = (element: HTMLElement | null): element is HTMLElement => !!element?.offsetParent && element.offsetWidth > 0;

export const dayInkContrast = (darkest: number) => (darkest + 0.05) / (DAY_INK_LUMINANCE + 0.05);
export const nightInkContrast = (brightest: number) => (NIGHT_INK_LUMINANCE + 0.05) / (brightest + 0.05);

export function nextTone(current: Tone, darkest: number, brightest: number): Tone {
  const day = dayInkContrast(darkest);
  const night = nightInkContrast(brightest);
  if (current === "light") return night > day * TONE_HYSTERESIS || (day < LARGE_TEXT_FLOOR && night > day) ? "dark" : "light";
  return day > night * TONE_HYSTERESIS || (night < LARGE_TEXT_FLOOR && day > night) ? "light" : "dark";
}

export class TextTones {
  private readonly title: HTMLElement | null;
  private readonly copy: () => HTMLElement[];
  private titleBoxes: Box[] = [];
  private copyBoxes: Box[] = [];
  private tone: Tone = "light";
  private decided = false;
  mist = 0;
  private readonly samples: number[] = [];

  constructor(
    private readonly hero: HTMLElement,
    private readonly reducedMotion: boolean,
    private readonly onTone: (tone: Tone) => void,
  ) {
    this.title = hero.querySelector<HTMLElement>(".hero-title");
    this.copy = () =>
      [...hero.querySelectorAll<HTMLElement>(".yc-yet, .lede, .welcome, .cta-row, [data-send-panel], .note, .pc-note")].filter(visible);
    if (this.title?.dataset.tone === "dark") this.tone = "dark";
  }

  measure() {
    const hero = this.hero;
    const offsetBox = (element: HTMLElement): Box => {
      let left = 0;
      let top = 0;
      let node: HTMLElement | null = element;
      while (node && node !== hero) {
        left += node.offsetLeft;
        top += node.offsetTop;
        node = node.offsetParent as HTMLElement | null;
      }
      return { left, top, right: left + element.offsetWidth, bottom: top + element.offsetHeight };
    };
    const heroLeft = hero.getBoundingClientRect().left;
    const range = document.createRange();
    const inkBox = (element: HTMLElement): Box => {
      const box = offsetBox(element);
      range.selectNodeContents(element);
      let left = Infinity;
      let right = -Infinity;
      for (const rect of range.getClientRects()) {
        if (rect.width < 1) continue;
        left = Math.min(left, rect.left - heroLeft);
        right = Math.max(right, rect.right - heroLeft);
      }
      return Number.isFinite(left) ? { ...box, left, right } : box;
    };
    this.titleBoxes = this.title ? [...this.title.querySelectorAll<HTMLElement>(".line > span")].filter(visible).map(inkBox) : [];
    this.copyBoxes = this.copy().map(offsetBox);
  }

  fallback(tone: Tone) {
    if (!this.decided) this.apply(tone);
  }

  estimate(darkest: number, brightest: number) {
    this.apply(nextTone(this.tone, darkest, brightest));
  }

  decide(pixels: Uint8Array, width: number, height: number, cssWidth: number, cssHeight: number) {
    const samples = this.samples;
    samples.length = 0;
    for (const box of this.titleBoxes) {
      const x0 = Math.max(0, Math.floor(((box.left - SAMPLE_PAD) / cssWidth) * width));
      const x1 = Math.min(width - 1, Math.ceil(((box.right + SAMPLE_PAD) / cssWidth) * width));
      const y0 = Math.max(0, Math.floor((1 - (box.bottom + SAMPLE_PAD) / cssHeight) * height));
      const y1 = Math.min(height - 1, Math.ceil((1 - (box.top - SAMPLE_PAD) / cssHeight) * height));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = (y * width + x) * 4;
          samples.push(0.2126 * SRGB_TO_LINEAR[pixels[i]] + 0.7152 * SRGB_TO_LINEAR[pixels[i + 1]] + 0.0722 * SRGB_TO_LINEAR[pixels[i + 2]]);
        }
      }
    }
    if (samples.length < 2) return;
    samples.sort((a, b) => a - b);
    const darkest = samples[Math.floor(samples.length * DARKEST_SHARE)];
    const brightest = samples[Math.min(samples.length - 1, Math.floor(samples.length * BRIGHTEST_SHARE))];
    this.decided = true;
    const tone = nextTone(this.tone, darkest, brightest);
    this.apply(tone);
    const worst = tone === "light" ? dayInkContrast(darkest) : nightInkContrast(brightest);
    if (worst < MIST_CALLS_AT) this.mist = this.reducedMotion ? 1 : Math.min(1, this.mist + MIST_RISE);
    else if (worst > MIST_LIFTS_AT) this.mist = this.reducedMotion ? 0 : Math.max(0, this.mist - MIST_FALL);
  }

  shadeAt(x: number, y: number, reach: number) {
    let nearest = Infinity;
    for (const box of [...this.titleBoxes, ...this.copyBoxes]) {
      const dx = Math.max(box.left - x, 0, x - box.right);
      const dy = Math.max(box.top - y, 0, y - box.bottom);
      nearest = Math.min(nearest, Math.hypot(dx, dy));
    }
    return Math.min(1, 0.15 + (0.85 * nearest) / reach);
  }

  private apply(tone: Tone) {
    if (tone === this.tone && this.title?.dataset.tone === tone) return;
    this.tone = tone;
    if (this.title) this.title.dataset.tone = tone;
    this.onTone(tone);
  }

  reset() {
    if (this.title) delete this.title.dataset.tone;
  }
}

export class ColorProbe {
  readonly width = PROBE_WIDTH;
  readonly height: number;
  readonly pixels: Uint8Array;
  private readonly texture: WebGLTexture;
  private readonly framebuffer: WebGLFramebuffer;
  private buffer: WebGLBuffer | null = null;
  private readonly halfWidth: number;
  private readonly halfHeight: number;
  private sync: WebGLSync | null = null;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly program: Program,
    sourceWidth: number,
    sourceHeight: number,
  ) {
    this.height = Math.max(8, Math.round((PROBE_WIDTH * sourceHeight) / sourceWidth));
    this.halfWidth = Math.max(this.width, Math.round(sourceWidth / 4));
    this.halfHeight = Math.max(this.height, Math.round(sourceHeight / 4));
    this.pixels = new Uint8Array(this.width * this.height * 4);
    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.width, this.height);
    this.framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  get pending() {
    return this.sync !== null;
  }

  capture(source: WebGLTexture) {
    const gl = this.gl;
    if (this.sync) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    this.program.use().int("uSource", 0).vec2("uHalfSize", this.halfWidth, this.halfHeight).vec2("uProbeSize", this.width, this.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buffer);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, this.pixels.byteLength, gl.STREAM_READ);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
  }

  colorAt(x: number, y: number, radius: number, cssWidth: number, cssHeight: number, warmest = false) {
    const cx = (x / cssWidth) * this.width - 0.5;
    const cy = (1 - y / cssHeight) * this.height - 0.5;
    const reach = Math.max(1, Math.round((radius / cssWidth) * this.width));
    let best: [number, number, number] | null = null;
    for (let py = Math.round(cy) - reach; py <= Math.round(cy) + reach; py++) {
      for (let px = Math.round(cx) - reach; px <= Math.round(cx) + reach; px++) {
        if (px < 0 || py < 0 || px >= this.width || py >= this.height || Math.hypot(px - cx, py - cy) > reach + 0.5) continue;
        const i = (py * this.width + px) * 4;
        const pixel: [number, number, number] = [this.pixels[i], this.pixels[i + 1], this.pixels[i + 2]];
        const score = warmest ? pixel[0] - pixel[2] : pixel[0] + pixel[1];
        if (!best || score > (warmest ? best[0] - best[2] : best[0] + best[1])) best = pixel;
      }
    }
    return best;
  }

  poll() {
    const gl = this.gl;
    if (!this.sync || gl.getSyncParameter(this.sync, gl.SYNC_STATUS) !== gl.SIGNALED) return false;
    gl.deleteSync(this.sync);
    this.sync = null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buffer);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.pixels);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.deleteBuffer(this.buffer);
    this.buffer = null;
    return true;
  }

  dispose() {
    const gl = this.gl;
    if (this.sync) gl.deleteSync(this.sync);
    this.sync = null;
    gl.deleteTexture(this.texture);
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteBuffer(this.buffer);
    this.buffer = null;
  }
}

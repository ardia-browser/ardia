import { CREEPER, HEAD, LEG_A, LEG_B, meadowHeight, MOB_FLOATS } from "./mobs";
import type { Particles } from "./particles";

type Stage = "waiting" | "appear" | "charge" | "fuse" | "aftermath" | "done";

export interface ChargeView {
  eye: [number, number, number];
  width: number;
  height: number;
  tanHalfWide: number;
  project(x: number, y: number, z: number): { x: number; y: number } | null;
}

export interface Shake {
  x: number;
  y: number;
  yaw: number;
  pitch: number;
}

const SPAWN_DELAY: [number, number] = [0.4, 1.2];
const APPEAR_SECONDS = 0.25;
const CHARGE_SECONDS = 1.6;
const FUSE_SECONDS = 0.7;
const FLASH_RISE_SECONDS = 0.08;
const FLASH_HOLD_SECONDS = 0.15;
const FLASH_FADE_SECONDS = 0.45;
const SHAKE_SECONDS = 0.3;
const AFTERMATH_SECONDS = 1.8;
const READY_GRACE_SECONDS = 1.5;
const FALLBACK_MS = 2500;
const SPAWN_DEPTH: [number, number] = [8, 12.5];
const END_DEPTH = 1.45;
const SPAWN_ATTEMPTS = 16;
const FUSE_HZ = 7;
const STEP_HZ = 5.5;
const SWING = 0.85;
const STAGE_SECONDS = { appear: APPEAR_SECONDS, charge: CHARGE_SECONDS, fuse: FUSE_SECONDS };

const PARTS = CREEPER.parts;
const HEIGHT = CREEPER.height;

const easeCharge = (t: number) => t * t * (2.2 - 1.2 * t);
const between = (low: number, high: number) => low + Math.random() * (high - low);

export class CreeperCharge {
  readonly data = new Float32Array(PARTS.length * MOB_FLOATS);
  readonly shake: Shake = { x: 0, y: 0, yaw: 0, pitch: 0 };
  contact: [number, number, number, number] | null = null;
  near = false;
  private stage: Stage = "waiting";
  private readonly createdAt = performance.now();
  private spawnAt = Infinity;
  private stageAt = 0;
  private boomAt = Infinity;
  private boomed = false;
  private fallback = 0;
  private flash: HTMLDivElement | null = null;
  private startX = 0;
  private startZ = 0;
  private endX = 0;
  private x = 0;
  private z = 0;
  private yaw = Math.PI;
  private phase = 0;
  private gait = 0;

  constructor(
    private readonly hero: HTMLElement,
    private readonly onBoom: () => void,
  ) {}

  get busy() {
    return this.stage !== "done";
  }

  begin(now: number) {
    if (this.stage !== "waiting" || this.spawnAt !== Infinity) return;
    this.spawnAt = now + between(...SPAWN_DELAY) * 1000;
  }

  abort(now: number) {
    if (this.boomed || this.stage === "done") return;
    this.stage = "done";
    this.contact = null;
    this.near = false;
    this.flash?.remove();
    this.flash = null;
    const wait = Math.max(0, this.createdAt + FALLBACK_MS - now);
    this.fallback = window.setTimeout(() => this.boom(), wait);
  }

  dispose() {
    clearTimeout(this.fallback);
    this.flash?.remove();
    this.flash = null;
  }

  shakeAt(now: number) {
    const s = this.shake;
    const t = (now - this.boomAt) / 1000;
    if (t < 0 || t > SHAKE_SECONDS) {
      s.x = s.y = s.yaw = s.pitch = 0;
      return s;
    }
    const decay = (1 - t / SHAKE_SECONDS) ** 2;
    s.x = (Math.random() * 2 - 1) * 0.06 * decay;
    s.y = (Math.random() * 2 - 1) * 0.04 * decay;
    s.yaw = (Math.random() * 2 - 1) * 0.022 * decay;
    s.pitch = (Math.random() * 2 - 1) * 0.018 * decay;
    return s;
  }

  update(now: number, view: ChargeView, drawable: boolean, particles: Particles, night: number) {
    if (this.stage === "done") return 0;
    if (this.stage === "waiting") {
      if (now < this.spawnAt) return 0;
      if (!drawable) {
        if (now > this.spawnAt + READY_GRACE_SECONDS * 1000) this.abort(now);
        return 0;
      }
      if (!this.place(view)) {
        this.abort(now);
        return 0;
      }
      this.enter("appear", now);
    }
    while (this.stage === "appear" || this.stage === "charge" || this.stage === "fuse") {
      const length = STAGE_SECONDS[this.stage] * 1000;
      if (now - this.stageAt < length) break;
      if (this.stage === "fuse") this.explode(now, view, particles, night);
      else this.enter(this.stage === "appear" ? "charge" : "fuse", this.stageAt + length);
    }
    this.paintFlash(now);
    if (this.stage === "aftermath") {
      if (now - this.boomAt > AFTERMATH_SECONDS * 1000) this.finish();
      return 0;
    }
    return drawable ? this.pose(now) : 0;
  }

  private enter(stage: Stage, at: number) {
    this.stage = stage;
    this.stageAt = at;
  }

  private place(view: ChargeView) {
    const { eye, width, height } = view;
    const reach = (CREEPER.reach / CREEPER.scale) * 0.7;
    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const across = side * between(0.36, 0.62);
      const z = between(...SPAWN_DEPTH);
      const x = eye[0] + across * view.tanHalfWide * z;
      const ground = meadowHeight(x, z);
      const foot = view.project(x - reach, ground, z);
      const head = view.project(x + reach, ground + HEIGHT, z);
      if (!foot || !head) continue;
      const left = Math.min(foot.x, head.x);
      const right = Math.max(foot.x, head.x);
      if (left < width * 0.05 || right > width * 0.95 || head.y < height * 0.04 || foot.y > height * 0.96) continue;
      this.startX = this.x = x;
      this.startZ = this.z = z;
      this.endX = eye[0];
      this.phase = Math.random() * Math.PI * 2;
      return true;
    }
    return false;
  }

  private pose(now: number) {
    const t = (now - this.stageAt) / 1000;
    let appear = 1;
    let swellXZ = 1;
    let swellY = 1;
    let flash = 0;
    let bob = 0;
    if (this.stage === "appear") {
      appear = Math.min(1, t / APPEAR_SECONDS);
      this.gait = 0;
    } else if (this.stage === "charge") {
      const p = Math.min(1, t / CHARGE_SECONDS);
      const progress = easeCharge(p);
      this.x = this.startX + (this.endX - this.startX) * progress;
      this.z = this.startZ + (END_DEPTH - this.startZ) * progress;
      const speed = (4.4 * p - 3.6 * p * p) / 1.35;
      this.gait = Math.min(1, 0.35 + speed);
      this.phase = Math.PI * 2 * STEP_HZ * t * (0.7 + 0.3 * p);
      bob = Math.abs(Math.cos(this.phase)) * 0.035 * this.gait;
    } else if (this.stage === "fuse") {
      const p = Math.min(1, t / FUSE_SECONDS);
      this.x = this.endX;
      this.z = END_DEPTH;
      this.gait = Math.max(0, 1 - t / 0.15);
      const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * FUSE_HZ - Math.PI / 2);
      const swell = p ** 1.4;
      swellXZ = 1 + 0.24 * swell + 0.04 * pulse;
      swellY = 1 + 0.1 * swell + 0.02 * pulse;
      flash = pulse > 0.5 ? 0.5 + 0.3 * swell : 0;
    }
    this.yaw = Math.atan2(this.endX - this.x, -this.z);
    this.near = this.stage === "fuse" || (this.stage === "charge" && this.z < this.startZ - (this.startZ - END_DEPTH) * 0.7);
    const lift = -(1 - appear) * HEIGHT * 0.45 + bob;
    const swing = Math.sin(this.phase) * this.gait * SWING;
    const data = this.data;
    for (let p = 0; p < PARTS.length; p++) {
      const part = PARTS[p];
      const pitch = part.role === LEG_A ? swing : part.role === LEG_B ? -swing : part.role === HEAD ? -0.08 * appear : 0;
      const o = p * MOB_FLOATS;
      data[o] = this.x;
      data[o + 1] = this.z;
      data[o + 2] = this.yaw;
      data[o + 3] = lift;
      data[o + 4] = part.pivot[0] * swellXZ;
      data[o + 5] = part.pivot[1] * swellY;
      data[o + 6] = part.pivot[2] * swellXZ;
      data[o + 7] = 0;
      data[o + 8] = part.offset[0] * swellXZ;
      data[o + 9] = part.offset[1] * swellY;
      data[o + 10] = part.offset[2] * swellXZ;
      data[o + 11] = pitch;
      data[o + 12] = part.size[0] * swellXZ;
      data[o + 13] = part.size[1] * swellY;
      data[o + 14] = part.size[2] * swellXZ;
      data[o + 15] = 0;
      data[o + 16] = part.color[0];
      data[o + 17] = part.color[1];
      data[o + 18] = part.color[2];
      data[o + 19] = appear;
      data[o + 20] = 0;
      data[o + 21] = 91.7 + p * 1.37;
      data[o + 22] = flash * 0.4;
      data[o + 23] = flash;
    }
    this.contact = [this.x, this.z, Math.max(CREEPER.reach * 1.6, 0.75) * swellXZ, appear];
    return PARTS.length;
  }

  private explode(now: number, view: ChargeView, particles: Particles, night: number) {
    this.stage = "aftermath";
    this.boomAt = now;
    this.contact = null;
    this.near = false;
    this.x = this.endX;
    this.z = END_DEPTH;
    const ground = meadowHeight(this.x, this.z);
    const centre = view.project(this.x, ground + HEIGHT * 0.55, this.z);
    const top = view.project(this.x, ground + HEIGHT, this.z);
    const cx = centre ? centre.x : view.width / 2;
    const cy = centre ? centre.y : view.height / 2;
    const tall = centre && top ? Math.max(40, Math.abs(cy - top.y) * 2) : view.height * 0.5;
    particles.smoke(cx, cy, tall * 0.45, tall * 0.55, Math.max(view.width, view.height) * 0.42);
    particles.burst(cx, cy, Math.max(night, 0.7));
    this.boom();
  }

  private flashOpacity(now: number) {
    if (this.stage === "fuse") {
      const left = FUSE_SECONDS - (now - this.stageAt) / 1000;
      return Math.min(1, Math.max(0, 1 - left / FLASH_RISE_SECONDS));
    }
    if (this.stage !== "aftermath") return 0;
    const t = (now - this.boomAt) / 1000;
    return t < FLASH_HOLD_SECONDS ? 1 : Math.max(0, 1 - (t - FLASH_HOLD_SECONDS) / FLASH_FADE_SECONDS);
  }

  private paintFlash(now: number) {
    const opacity = this.flashOpacity(now);
    if (!this.flash) {
      if (opacity <= 0) return;
      const flash = document.createElement("div");
      flash.setAttribute("aria-hidden", "true");
      Object.assign(flash.style, { position: "absolute", inset: "0", background: "#fff", pointerEvents: "none", zIndex: "10" });
      this.hero.appendChild(flash);
      this.flash = flash;
    }
    this.flash.style.opacity = opacity.toFixed(3);
  }

  private finish() {
    this.stage = "done";
    this.flash?.remove();
    this.flash = null;
  }

  private boom() {
    if (this.boomed) return;
    this.boomed = true;
    this.onBoom();
  }
}

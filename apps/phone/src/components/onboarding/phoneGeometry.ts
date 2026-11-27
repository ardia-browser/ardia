import type { PhoneSlotReport, SlotRect } from "./OnboardingKit";
import { phoneFrame } from "./onboardingTokens";

export type FrameTarget = { centerX: number; centerY: number; scale: number };

export const phoneSize = (scale: number) => ({ width: phoneFrame.width * scale, height: phoneFrame.height * scale });

export const frameTarget = (rect: SlotRect): FrameTarget => ({ centerX: rect.x + rect.width / 2, centerY: rect.y + rect.height / 2, scale: rect.width / phoneFrame.width });

export const scaledFromTopLeft = (width: number, height: number, scale: number) => [{ translateX: ((scale - 1) * width) / 2 }, { translateY: ((scale - 1) * height) / 2 }, { scale }];

export const fitPhoneScale = (width: number, height: number, range: { minScale: number; maxScale: number }) =>
  Math.min(range.maxScale, Math.max(range.minScale, Math.min(width / phoneFrame.width, height / phoneFrame.height)));

export const sameSlot = (a: PhoneSlotReport | undefined, b: PhoneSlotReport) =>
  !!a && a.screen === b.screen && a.rect.x === b.rect.x && a.rect.y === b.rect.y && a.rect.width === b.rect.width && a.rect.height === b.rect.height;

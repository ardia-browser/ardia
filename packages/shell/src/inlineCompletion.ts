import { nativeModule } from "./nativeModules";
import type { InlineCompletionNative } from "./generated/native";

export type { InlineCompletionNative };

const InlineCompletionModule = nativeModule("ArdiaInlineCompletion");

export type InlineWrite = 0 | 1 | 2;

export const completeInline = (tag: number, typed: string, completion: string) =>
  InlineCompletionModule.complete(tag, typed, completion);

export const copyFieldAs = (shown: string | null, url: string | null) => InlineCompletionModule.copyFieldAs(shown, url);

export const keepInlineWhileTyping = (tag: number, on: boolean) => void InlineCompletionModule.keepWhileTyping?.(tag, on)?.catch(() => {});

export function takeKeptInline(tag: number, start: number, end: number): { typed: string; completion: string } | null {
  const [typed, completion] = InlineCompletionModule.takeKept?.(tag, start, end) ?? [];
  return typeof typed === "string" && typeof completion === "string" ? { typed, completion } : null;
}

import { useLayoutEffect, useRef, type RefObject } from "react";
import type { TextInput } from "react-native";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { barFieldMarks } from "../../state/omnibox/barMarks";
import { noteDroppedLetterRestored } from "../../state/telemetry/inlineCompletionCounts";
import type { Selection } from "./inline";
import { freshRevertWatch, readNativeText, wroteOverField } from "./revertedText";

export function useRevertRepair(
  inputRef: RefObject<TextInput | null>,
  variant: string,
  value: string | undefined,
  onChangeText: ((text: string) => void) | undefined,
  onSelection: (next: Selection) => void,
) {
  const watch = useRef(freshRevertWatch());
  const caret = useRef<Selection>({ start: 0, end: 0 });
  const handedOn = useRef<string | null>(null);
  const pending = useRef<{ text: string; at: number } | null>(null);

  useLayoutEffect(() => {
    if (value === undefined || handedOn.current === null || value === handedOn.current) return;
    watch.current = wroteOverField(watch.current);
  }, [value]);

  useLayoutEffect(() => {
    const restoring = pending.current;
    if (!restoring) return;
    pending.current = null;
    if (!value?.startsWith(restoring.text)) return;
    caret.current = { start: restoring.at, end: restoring.at };
    inputRef.current?.setSelection(restoring.at, restoring.at);
    onSelection(caret.current);
  }, [value]);

  const changed = (next: string) => {
    if (!PLATFORM_FEATURES.textInputRevertsFirstChange) return onChangeText?.(next);
    const read = readNativeText(watch.current, next, caret.current, Date.now());
    watch.current = read.watch;
    if (read.restored) {
      noteDroppedLetterRestored();
      barFieldMarks.repair(variant, read.restored.text.length, read.restored.at);
    }
    pending.current = read.caret === null ? null : { text: read.text, at: read.caret };
    handedOn.current = read.text;
    onChangeText?.(read.text);
  };

  const selected = (next: Selection) => {
    caret.current = next;
  };

  return { changed, selected };
}

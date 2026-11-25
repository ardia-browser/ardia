import { caretAllowsInline, completeInline, keepInlineWhileTyping, selectInlineCompletion, takeKeptInline } from "../../state/omnibox/textInput";
import { noteInlineCompletionKept, noteInlineCompletionShown } from "../../state/telemetry/inlineCompletionCounts";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { findNodeHandle, type TextInput } from "react-native";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { useKeyHoldReplay } from "./keyHoldReplay";
import { acceptsCompletion, completionToWrite, keptTyping, previewFieldChange, settlesInline, withoutFirst, type EditContext, type FieldChange, type Inline, type PendingInline, type Selection } from "./inline";

export function useInlineCompletion(input: RefObject<TextInput | null>, typed: string, wanted: string, preview: string | null, caret: () => Selection) {
  const [inline, setInline] = useState<Inline | null>(null);
  const pending = useRef<PendingInline[]>([]);
  const heard = useRef(typed);
  const counted = useRef("");
  const replaying = useKeyHoldReplay(input);
  const shown = !replaying && inline?.typed === typed ? inline.completion : "";

  useEffect(() => {
    const tag = findNodeHandle(input.current);
    if (tag == null) return;
    keepInlineWhileTyping(tag, true);
    return () => keepInlineWhileTyping(tag, false);
  }, [input]);

  useLayoutEffect(() => {
    if (typed !== heard.current) {
      heard.current = typed;
      pending.current = pending.current.map((p) => ({ ...p, orphaned: true }));
    }
    if (preview !== null || replaying) return;
    const write = completionToWrite(typed, wanted, shown, pending.current);
    const tag = write && findNodeHandle(input.current);
    if (!write || tag == null) return;
    pending.current = [...pending.current, write];
    const settle = (result: number) => {
      if (result === 2) return;
      pending.current = withoutFirst(pending.current, write);
      const { start, end } = caret();
      if (settlesInline(result === 1, write.completion, caretAllowsInline(start, end, write.typed.length))) setInline(write);
    };
    completeInline(tag, write.typed, write.completion).then(settle, () => settle(0));
  }, [input, typed, wanted, shown, preview, replaying]);

  const read = (next: string, edit?: EditContext): FieldChange => {
    const change = previewFieldChange(typed, shown, preview, next, PLATFORM_FEATURES.inlineWritesEcho ? pending.current : [], edit);
    if (change.echo) {
      pending.current = pending.current.slice(change.settled);
      if (!change.stale) setInline(change.inline);
    } else {
      heard.current = change.typed;
      setInline(null);
    }
    return change;
  };

  useLayoutEffect(() => {
    if (!shown) counted.current = "";
    if (!shown || preview !== null) return;
    selectInlineCompletion(input.current, typed.length, typed.length + shown.length);
    const key = `${typed}\n${shown}`;
    if (counted.current === key) return;
    counted.current = key;
    noteInlineCompletionShown();
  }, [input, typed, shown, preview]);

  const accepts = (selection: Selection) => preview === null && acceptsCompletion(typed, shown, selection, pending.current);

  const kept = (selection: Selection): string | null => {
    const tag = findNodeHandle(input.current);
    if (preview !== null || tag == null) return null;
    const next = keptTyping(typed, selection, (start, end) => takeKeptInline(tag, start, end));
    if (!next) return null;
    heard.current = next.typed;
    pending.current = pending.current.map((p) => ({ ...p, orphaned: true }));
    setInline(next);
    noteInlineCompletionKept();
    return next.typed;
  };

  return { shown, read, accepts, kept };
}

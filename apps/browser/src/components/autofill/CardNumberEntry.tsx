import { useRef, useState, type ReactNode } from "react";
import type { TextInput } from "react-native";
import type { CardNumberSummary, SavedCard } from "../../state/site/autofill";
import { copyCardNumber, readCardNumber, showCardNumber } from "../../state/autofill/actions";
import { cardDigits, cardNumberSummary, formatCardNumber } from "../../state/autofill/cards";
import { copyText } from "../../state/app/system";
import { vaultsSupported } from "../../state/vaults/enabled";
import { CardNumberField, useSecretEntry, type CardNumberFieldHandle } from "../ui";
import { PlainField } from "../vaults/VaultFormFields";

export type CardNumberReveal = "shown" | "declined" | "failed";

export type CardNumberFieldProps = {
  autoFocus: boolean;
  style: object;
  onEdited: () => void;
  onSubmit: () => void;
  onEscape: () => void;
  onTab: (back: boolean) => void;
  onFocusChange: (focused: boolean) => void;
};

export type CardNumberEntry = {
  summary: CardNumberSummary | null;
  revealed: boolean;
  reveal: () => Promise<CardNumberReveal>;
  copy: () => Promise<"copied" | Exclude<CardNumberReveal, "shown">>;
  savedNumber: () => string | undefined;
  focus: () => void;
  field: (props: CardNumberFieldProps) => ReactNode;
};

function useSecureCardNumber(profile: string, saved: SavedCard | undefined): CardNumberEntry {
  const typedEntry = useSecretEntry();
  const shownEntry = useSecretEntry();
  const [revealed, setRevealed] = useState(false);
  const [summary, setSummary] = useState<CardNumberSummary | null>(null);
  const view = useRef<CardNumberFieldHandle>(null);
  const entry = saved ? shownEntry : typedEntry;
  const reveal = async (): Promise<CardNumberReveal> => {
    if (revealed || !saved) return "shown";
    const result = await showCardNumber(profile, saved.id, shownEntry);
    if (!result.shown) return result.declined ? "declined" : "failed";
    setRevealed(true);
    return "shown";
  };
  return {
    summary,
    revealed,
    reveal,
    copy: async () => {
      const shown = await reveal();
      if (shown !== "shown") return shown;
      return (await copyCardNumber(shownEntry)) ? "copied" : "failed";
    },
    savedNumber: () => (!saved || revealed ? entry : undefined),
    focus: () => view.current?.focus(),
    field: ({ autoFocus, style, onEdited, onSubmit, onEscape, onTab, onFocusChange }) => (
      <CardNumberField
        ref={view}
        entry={entry}
        label="Card Number"
        placeholder="Required"
        autoFocus={autoFocus}
        style={style}
        onEdit={(next) => (setSummary(next), onEdited())}
        onSubmit={onSubmit}
        onEscape={onEscape}
        onTab={onTab}
        onFocusChange={onFocusChange}
      />
    ),
  };
}

function usePlainCardNumber(profile: string, saved: SavedCard | undefined): CardNumberEntry {
  const [text, setText] = useState("");
  const [revealed, setRevealed] = useState(false);
  const input = useRef<TextInput>(null);
  const known = useRef<string | null>(null);
  const reveal = async (): Promise<CardNumberReveal> => {
    if (revealed || !saved) return "shown";
    const number = await readCardNumber(profile, saved.id);
    if (!number) return "declined";
    known.current = cardDigits(number);
    setText(formatCardNumber(number));
    setRevealed(true);
    return "shown";
  };
  const digits = cardDigits(text);
  return {
    summary: !saved || revealed ? cardNumberSummary(digits) : null,
    revealed,
    reveal,
    copy: async () => {
      const shown = await reveal();
      if (shown !== "shown") return shown;
      const number = revealed ? digits : known.current;
      if (!number) return "failed";
      copyText(number);
      return "copied";
    },
    savedNumber: () => (!saved || revealed ? digits : undefined),
    focus: () => input.current?.focus(),
    field: ({ autoFocus, onEdited, onSubmit, onEscape, onTab, onFocusChange }) => (
      <PlainField
        inputRef={input}
        label="Card Number"
        placeholder="Required"
        value={text}
        autoFocus={autoFocus}
        mono
        onChangeText={(next) => (setText(formatCardNumber(next)), onEdited())}
        onSubmit={onSubmit}
        onEscape={onEscape}
        onTab={onTab}
        onFocusChange={onFocusChange}
      />
    ),
  };
}

export const useCardNumberEntry: (profile: string, saved: SavedCard | undefined) => CardNumberEntry = vaultsSupported ? useSecureCardNumber : usePlainCardNumber;

import { useMemo, useRef, useState } from "react";
import { View, type TextInput } from "react-native";
import type { SavedCard } from "../../state/site/autofill";
import { deleteAutofillEntry, saveCardFromSettings } from "../../state/autofill/actions";
import { cardFormProblem, cardTitle, expiryYears, type CardFormProblem } from "../../state/autofill/cards";
import { confirm } from "../../state/app/system";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import { closeSettingsSheet } from "../../state/settings/sheet";
import { Box, Button, Dialog, DialogActions, Expand, Group, PopUp, space, tabularNums, Text, type Option } from "../ui";
import { useCardNumberEntry } from "./CardNumberEntry";
import { NetworkBadge } from "../site/Autofill";
import { FIELD, FormRow, LABEL_WIDTH, PlainField, ROW, ROW_LINE } from "../vaults/VaultFormFields";
import { VAULT_FORM } from "../vaults/tokens";
import { useCopiedFlash } from "../vaults/VaultParts";
import { HeaderTile, SheetHeader } from "../vaults/VaultSignInParts";
import { AUTOFILL } from "./tokens";

type Focus = "number" | "name" | null;

const PROBLEM_TEXT: Record<CardFormProblem, string> = {
  number: "Enter a valid card number.",
  expiry: "Choose an expiry date that hasn't passed.",
};

const SAVE_FAILED = "Couldn't save the card. Try again.";
const SHOW_DECLINED = `Showing the number needs ${PLATFORM_TERMS.deviceUnlock}.`;

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS: Option<string>[] = [
  { value: "", title: "Month" },
  ...Array.from({ length: 12 }, (_, i) => ({
    value: String(i + 1),
    title: pad(i + 1),
  })),
];

export function CardSheet({ profile, saved }: { profile: string; saved?: SavedCard }) {
  const isNew = !saved;
  const cardNumber = useCardNumberEntry(profile, saved);
  const { revealed, summary: number } = cardNumber;
  const [name, setName] = useState(saved?.name ?? "");
  const [month, setMonth] = useState(saved?.expMonth ? String(saved.expMonth) : "");
  const [year, setYear] = useState(saved?.expYear ? String(saved.expYear) : "");
  const [focus, setFocus] = useState<Focus>(null);
  const [tried, setTried] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, flashCopied] = useCopiedFlash();
  const saving = useRef(false);
  const nameField = useRef<TextInput>(null);
  const now = useMemo(() => new Date(), []);
  const years = useMemo<Option<string>[]>(
    () => [
      { value: "", title: "Year" },
      ...expiryYears(now, saved?.expYear).map((y) => ({
        value: String(y),
        title: String(y),
      })),
    ],
    [now, saved?.expYear],
  );

  const editingNumber = isNew || revealed;
  const problem = cardFormProblem({
    isNew,
    number: editingNumber ? number : null,
    month,
    year,
    now,
  });
  const shownProblem = tried ? problem : null;
  const message = shownProblem ? PROBLEM_TEXT[shownProblem] : note;
  const network = number?.digits ? number.network : (saved?.network ?? "card");
  const focusOn = (which: Exclude<Focus, null>) => (on: boolean) => setFocus((f) => (on ? which : f === which ? null : f));
  const tab = (from: Exclude<Focus, null>) => () => (from === "number" || !editingNumber ? nameField.current?.focus() : cardNumber.focus());

  const reveal = async () => {
    setNote("");
    const outcome = await cardNumber.reveal();
    if (outcome === "declined") setNote(SHOW_DECLINED);
    return outcome === "shown";
  };

  const copy = async () => {
    setNote("");
    const outcome = await cardNumber.copy();
    if (outcome === "copied") flashCopied();
    else if (outcome === "declined") setNote(SHOW_DECLINED);
  };

  const save = async () => {
    if (saving.current) return;
    setTried(true);
    if (problem) {
      if (problem === "number") cardNumber.focus();
      return;
    }
    const unchanged =
      !!saved && !revealed && name.trim() === (saved.name ?? "").trim() && month === (saved.expMonth ? String(saved.expMonth) : "") && year === (saved.expYear ? String(saved.expYear) : "");
    if (unchanged) return closeSettingsSheet();
    saving.current = true;
    setBusy(true);
    setNote("");
    const outcome = await saveCardFromSettings(
      profile,
      {
        id: saved?.id,
        name: name.trim(),
        expMonth: month ? Number(month) : undefined,
        expYear: year ? Number(year) : undefined,
      },
      cardNumber.savedNumber(),
    );
    saving.current = false;
    setBusy(false);
    if (outcome === "saved") return closeSettingsSheet();
    setNote(outcome === "invalid" ? PROBLEM_TEXT.number : SAVE_FAILED);
  };

  const remove = async () => {
    if (!saved) return;
    const { confirmed } = await confirm({
      title: `Delete ${cardTitle(saved)}?`,
      message: "Ardia won't offer this card at checkout anymore.",
      confirmTitle: "Delete",
      destructive: true,
    });
    if (!confirmed) return;
    setBusy(true);
    await deleteAutofillEntry(profile, { kind: "card", saved });
    closeSettingsSheet();
  };

  return (
    <Dialog width="m" maxHeight="90%" onDismiss={closeSettingsSheet} onSubmit={() => void save()} focusInside>
      <SheetHeader
        icon={
          <HeaderTile>
            <NetworkBadge network={network} />
          </HeaderTile>
        }
        title={saved ? cardTitle(saved) : "New Card"}
      />
      <View style={BODY}>
        <Group>
          {editingNumber ? (
            <FormRow label="Number" focused={focus === "number"} invalid={shownProblem === "number"}>
              <Box row gap="xs" center>
                {cardNumber.field({
                  autoFocus: isNew,
                  style: NUMBER,
                  onEdited: () => setNote(""),
                  onSubmit: () => void save(),
                  onEscape: closeSettingsSheet,
                  onTab: tab("number"),
                  onFocusChange: focusOn("number"),
                })}
                {saved ? <Button variant="icon" icon={copied ? "checkmark" : "doc.on.doc"} size="m" tooltip={copied ? "Copied" : "Copy Number"} onPress={() => void copy()} /> : null}
              </Box>
            </FormRow>
          ) : (
            <View style={ROW}>
              <View style={ROW_LINE}>
                <Text style={LABEL} lines={1}>
                  Number
                </Text>
                <Box row gap="xs" center style={FIELD}>
                  <Text style={[tabularNums, GROW]} accessibilityLabel={`Card number ending in ${saved!.last4}`}>
                    {`•••• •••• •••• ${saved!.last4}`}
                  </Text>
                  <Button variant="icon" icon="eye" size="m" tooltip="Show Number" onPress={() => void reveal()} />
                  <Button variant="icon" icon={copied ? "checkmark" : "doc.on.doc"} size="m" tooltip={copied ? "Copied" : "Copy Number"} onPress={() => void copy()} />
                </Box>
              </View>
            </View>
          )}
          <FormRow label="Name" focused={focus === "name"}>
            <PlainField
              inputRef={nameField}
              label="Name on Card"
              value={name}
              onChangeText={setName}
              placeholder="Name on Card"
              autoFocus={!isNew}
              onSubmit={() => void save()}
              onEscape={closeSettingsSheet}
              onTab={tab("name")}
              onFocusChange={focusOn("name")}
            />
          </FormRow>
          <View style={ROW}>
            <View style={ROW_LINE}>
              <Text style={LABEL} tone={shownProblem === "expiry" ? "destructive" : "textPrimary"} lines={1}>
                Expires
              </Text>
              <Box row gap="s" center style={FIELD}>
                <PopUp value={month} options={MONTHS} onChange={(v) => (setMonth(v), setNote(""))} minWidth={AUTOFILL.monthWidth} />
                <PopUp value={year} options={years} onChange={(v) => (setYear(v), setNote(""))} minWidth={AUTOFILL.yearWidth} />
              </Box>
            </View>
          </View>
        </Group>
        <Expand open={!!message} gap={space.ml}>
          <Text size="caption" tone="destructive">
            {message}
          </Text>
        </Expand>
      </View>
      <DialogActions leading={saved ? <Button title="Delete" kind="destructive" disabled={busy} onPress={() => void remove()} /> : null}>
        <Button title="Cancel" disabled={busy} onPress={closeSettingsSheet} />
        <Button title="Save" kind="primary" busy={busy} onPress={() => void save()} />
      </DialogActions>
    </Dialog>
  );
}

const BODY = { marginTop: space.xl } as const;
const LABEL = { width: LABEL_WIDTH } as const;
const GROW = { flex: 1 } as const;
const NUMBER = { flex: 1, height: VAULT_FORM.fieldHeight } as const;

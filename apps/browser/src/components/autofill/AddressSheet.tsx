import { useRef, useState } from "react";
import { ScrollView, View, type TextInput } from "react-native";
import { addressChanged, addressFormOf, addressInputOf, addressProblem, addressTitle, regionLabels, type AddressForm, type AddressProblem } from "../../state/autofill/addresses";
import { deleteAutofillEntry, saveAddressFromSettings } from "../../state/autofill/actions";
import { confirm } from "../../state/app/system";
import { closeSettingsSheet } from "../../state/settings/sheet";
import type { SavedAddress } from "../../state/site/autofill";
import { Button, Dialog, DialogActions, Expand, Group, space, Text, useTheme, withAlpha } from "../ui";
import { FIELD, FOCUS_RING, FormRow, LABEL_WIDTH, PlainField, ROW, ROW_LINE } from "../vaults/VaultFormFields";
import { VAULT_SIGN_IN } from "../vaults/tokens";
import { HeaderTile, SheetHeader } from "../vaults/VaultSignInParts";
import { AddressGlyph } from "./AutofillParts";
import { AUTOFILL } from "./tokens";

type Key = keyof AddressForm;

const PROBLEM_TEXT: Record<AddressProblem, string> = {
  empty: "Enter a name or an address.",
  email: "Enter an email like name@example.com.",
  phone: "Check the phone number.",
};

const FLAGGED: Record<AddressProblem, Key | null> = {
  empty: null,
  email: "email",
  phone: "phone",
};

type FieldSpec = {
  key: Key;
  label: string;
  placeholder?: string;
  a11y?: string;
};

type RowSpec = FieldSpec | readonly [FieldSpec, FieldSpec];

function groupsOf(country: string): RowSpec[][] {
  const labels = regionLabels(country);
  return [
    [
      { key: "name", label: "Name", placeholder: "Full Name" },
      { key: "organization", label: "Organization", placeholder: "Optional" },
      { key: "phone", label: "Phone", placeholder: "Phone Number" },
      { key: "email", label: "Email", placeholder: "name@example.com" },
    ],
    [
      { key: "street1", label: "Street", placeholder: "Street Address" },
      {
        key: "street2",
        label: "",
        placeholder: "Apt, Suite, Floor",
        a11y: "Street, Line 2",
      },
      [
        { key: "city", label: "City", placeholder: "City" },
        { key: "state", label: labels.region, placeholder: labels.region },
      ],
      [
        { key: "postalCode", label: labels.postal, placeholder: labels.postal },
        { key: "country", label: "Country", placeholder: "US" },
      ],
    ],
  ];
}

export function AddressSheet({ profile, saved }: { profile: string; saved?: SavedAddress }) {
  const [form, setForm] = useState<AddressForm>(() => addressFormOf(saved));
  const [focus, setFocus] = useState<Key | null>(null);
  const [tried, setTried] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const groups = groupsOf(form.country);
  const theme = useTheme();
  const order = groups.flat(2).map((f) => f.key);
  const inputs = useRef<Partial<Record<Key, TextInput | null>>>({});
  const problem = addressProblem(form);
  const shownProblem = tried ? problem : null;
  const message = shownProblem ? PROBLEM_TEXT[shownProblem] : failed ? "Couldn't save the address. Try again." : "";

  const set = (key: Key) => (text: string) => {
    setFailed(false);
    setForm((f) => ({ ...f, [key]: text }));
  };
  const tabFrom = (key: Key) => (back: boolean) => {
    const at = order.indexOf(key);
    inputs.current[order[(at + (back ? order.length - 1 : 1)) % order.length]!]?.focus();
  };
  const focusOn = (key: Key) => (on: boolean) => setFocus((now) => (on ? key : now === key ? null : now));

  const save = async () => {
    if (saving.current) return;
    setTried(true);
    if (problem) {
      const flagged = FLAGGED[problem];
      if (flagged) inputs.current[flagged]?.focus();
      return;
    }
    if (saved && !addressChanged(saved, form)) return closeSettingsSheet();
    saving.current = true;
    setBusy(true);
    const ok = await saveAddressFromSettings(profile, addressInputOf(form, saved?.id));
    saving.current = false;
    setBusy(false);
    if (ok) return closeSettingsSheet();
    setFailed(true);
  };

  const remove = async () => {
    if (!saved) return;
    const { confirmed } = await confirm({
      title: `Delete ${addressTitle(saved)}?`,
      message: "Ardia won't offer this address in forms anymore.",
      confirmTitle: "Delete",
      destructive: true,
    });
    if (!confirmed) return;
    setBusy(true);
    await deleteAutofillEntry(profile, { kind: "address", saved });
    closeSettingsSheet();
  };

  const title = saved ? addressTitle(saved) : "New Address";
  return (
    <Dialog width="m" maxHeight="90%" onDismiss={closeSettingsSheet} onSubmit={() => void save()} focusInside>
      <SheetHeader
        icon={
          <HeaderTile>
            <AddressGlyph address={saved ?? { name: form.name, organization: form.organization }} size={AUTOFILL.tileGlyph} />
          </HeaderTile>
        }
        title={title}
      />
      <View style={BODY}>
        <ScrollView style={SCROLL} showsVerticalScrollIndicator={false}>
          {groups.map((rows, g) => (
            <View key={g} style={g ? GROUP_GAP : undefined}>
              <Group>
                {rows.map((row) => {
                  const invalid = (f: FieldSpec) => !!shownProblem && FLAGGED[shownProblem] === f.key;
                  const field = (f: FieldSpec) => (
                    <PlainField
                      inputRef={(el) => void (inputs.current[f.key] = el)}
                      label={f.a11y ?? f.label}
                      value={form[f.key]}
                      onChangeText={set(f.key)}
                      placeholder={f.placeholder}
                      autoFocus={!saved && f.key === "name"}
                      onSubmit={() => void save()}
                      onEscape={closeSettingsSheet}
                      onTab={tabFrom(f.key)}
                      onFocusChange={focusOn(f.key)}
                    />
                  );
                  if (!Array.isArray(row)) {
                    const f = row as FieldSpec;
                    return (
                      <FormRow key={f.key} label={f.label} focused={focus === f.key} invalid={invalid(f)}>
                        {field(f)}
                      </FormRow>
                    );
                  }
                  const [a, b] = row as readonly [FieldSpec, FieldSpec];
                  const ring = (f: FieldSpec) => (focus === f.key ? <View pointerEvents="none" style={[FOCUS_RING, { borderColor: withAlpha(theme.formAccent, VAULT_SIGN_IN.ringAlpha) }]} /> : null);
                  return (
                    <View key={a.key} style={ROW}>
                      <View style={ROW_LINE}>
                        <Text style={LABEL} lines={1}>
                          {a.label}
                        </Text>
                        <View style={FIELD}>
                          {ring(a)}
                          {field(a)}
                        </View>
                        <Text lines={1}>{b.label}</Text>
                        <View style={FIELD}>
                          {ring(b)}
                          {field(b)}
                        </View>
                      </View>
                    </View>
                  );
                })}
              </Group>
            </View>
          ))}
        </ScrollView>
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
const GROUP_GAP = { marginTop: space.l } as const;
const LABEL = { width: LABEL_WIDTH } as const;
const SCROLL = { maxHeight: AUTOFILL.sheetBody } as const;

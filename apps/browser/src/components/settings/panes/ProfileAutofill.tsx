import {
  cardNetworkName,
  deleteAddress,
  deleteCard,
  revealCardNumber,
  saveAddress,
  saveCard,
  type SavedAddress,
  type SavedCard,
} from "../../../state/site/autofill";
import { orWarn } from "../../../lib/fallback";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";
import { confirm, copyText } from "../../../state/app/system";
import { Box, Button, DialogActions, DialogTitle, type Option, PopUp, Sheet, space, Symbol, Text, TextField } from "../../ui";
import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { useTheme } from "../../ui/theme";
import { currentEngineProfile } from "../../../state/browser/current";
import { Group, Row, SectionHeader } from "../Form";
import { NetworkBadge } from "../../site/Autofill";
import { addresses as addressList, cards as cardList } from "../../../state/settings/paneData";
import { useResource } from "../../../state/settings/resources";
import { closeSettingsSheet, showSettingsSheet } from "../../../state/settings/sheet";
import { setting } from "../settingsIndex";
import { ProfileSubPage } from "./ProfileSubPage";
import { t } from "../../../lib/uiLanguage";


export function AddressesPage({ profileId }: { profileId: string }) {
  const theme = useTheme();
  const profile = currentEngineProfile(profileId);
  const [addresses, reload] = useResource(addressList, profile);
  const load = () => void reload();

  return (
    <ProfileSubPage>
      <SectionHeader
        title={t(`Addresses`)}
        description={setting("profiles.addresses").description}
        action={<Button title={t(`Add Address…`)} onPress={() => showSettingsSheet(<AddressSheet profile={profile} onChanged={load} />)} />}
      />
      <Group>
        {addresses && !addresses.length ? (
          <Row title={t(`No saved addresses`)} description={t(`Addresses you enter in forms can be saved here.`)} />
        ) : (
          (addresses ?? []).map((a) => (
            <Row
              key={a.id}
              icon={<Symbol name="person.crop.circle" size={15} color={theme.icon} style={PERSON_ICON} />}
              title={a.name || firstLine(a.street) || a.email || t(`Address`)}
              description={addressSummary(a)}
              onPress={() => showSettingsSheet(<AddressSheet profile={profile} saved={a} onChanged={load} />)}
            />
          ))
        )}
      </Group>
    </ProfileSubPage>
  );
}

export function CardsPage({ profileId }: { profileId: string }) {
  const profile = currentEngineProfile(profileId);
  const [cards, reload] = useResource(cardList, profile);
  const load = () => void reload();

  return (
    <ProfileSubPage>
      <SectionHeader
        title={t(`Cards`)}
        description={`${setting("profiles.cards").description} Card numbers are kept in ${PLATFORM_TERMS.secretStore}.`}
        action={<Button title={t(`Add Card…`)} onPress={() => showSettingsSheet(<CardSheet profile={profile} onChanged={load} />)} />}
      />
      <Group>
        {cards && !cards.length ? (
          <Row title={t(`No saved cards`)} description={t(`Cards you enter at checkout can be saved here.`)} />
        ) : (
          (cards ?? []).map((c) => (
            <Row
              key={c.id}
              icon={<NetworkBadge network={c.network} />}
              title={`${cardNetworkName(c.network)} •••• ${c.last4}`}
              description={cardSummary(c)}
              onPress={() => showSettingsSheet(<CardSheet profile={profile} saved={c} onChanged={load} />)}
            />
          ))
        )}
      </Group>
    </ProfileSubPage>
  );
}

const PERSON_ICON = { width: 22, height: 22 } as const;

const firstLine = (street?: string) => street?.split("\n")[0] ?? "";

function addressSummary(a: SavedAddress) {
  const place = [a.city, a.state, a.postalCode].filter(Boolean).join(" ");
  return [a.name ? firstLine(a.street) : "", place, a.email].filter(Boolean).join(", ");
}

const pad = (n: number) => String(n).padStart(2, "0");

function isExpired(c: SavedCard) {
  if (!c.expMonth || !c.expYear) return false;
  const now = new Date();
  return c.expYear < now.getFullYear() || (c.expYear === now.getFullYear() && c.expMonth < now.getMonth() + 1);
}

function cardSummary(c: SavedCard) {
  const expiry = c.expMonth && c.expYear ? `${isExpired(c) ? "Expired" : "Expires"} ${pad(c.expMonth)}/${pad(c.expYear % 100)}` : "";
  return [expiry, c.name].filter(Boolean).join(" · ");
}

function formatCardNumber(digits: string) {
  const groups = /^3[47]/.test(digits) ? [4, 6, 5] : [4, 4, 4, 4, 3];
  const out: string[] = [];
  let i = 0;
  for (const g of groups) {
    if (i >= digits.length) break;
    out.push(digits.slice(i, i + g));
    i += g;
  }
  if (i < digits.length) out.push(digits.slice(i));
  return out.join(" ");
}

function FormRow({ title, children }: { title: string; children: ReactNode }) {
  return <Row title={title}>{children}</Row>;
}

async function confirmDelete(title: string, message: string) {
  const { confirmed } = await confirm({ title, message, confirmTitle: t(`Delete`), destructive: true });
  return confirmed;
}

function SheetButtons({ canDelete, onDelete, onSave, saveDisabled }: { canDelete: boolean; onDelete: () => void; onSave: () => void; saveDisabled?: boolean }) {
  return (
    <DialogActions leading={canDelete ? <Button title={t(`Delete`)} kind="destructive" onPress={onDelete} /> : null}>
      <Button title={t(`Cancel`)} onPress={closeSettingsSheet} />
      <Button title={t(`Save`)} kind="primary" disabled={saveDisabled} onPress={onSave} />
    </DialogActions>
  );
}

const ADDRESS_FIELDS: { key: keyof SavedAddress | "line1" | "line2"; title: string }[] = [
  { key: "name", title: t(`Name`) },
  { key: "organization", title: t(`Organization`) },
  { key: "line1", title: t(`Street Address`) },
  { key: "line2", title: t(`Apt, Suite, etc.`) },
  { key: "city", title: t(`City`) },
  { key: "state", title: t(`State / Province`) },
  { key: "postalCode", title: t(`ZIP / Postal Code`) },
  { key: "country", title: t(`Country / Region`) },
  { key: "phone", title: t(`Phone`) },
  { key: "email", title: t(`Email`) },
];

function AddressSheet({ profile, saved, onChanged }: { profile: string; saved?: SavedAddress; onChanged: () => void }) {
  const [lines] = useState(() => (saved?.street ?? "").split("\n"));
  const [values, setValues] = useState<Record<string, string>>(() => ({
    name: saved?.name ?? "",
    organization: saved?.organization ?? "",
    line1: lines[0] ?? "",
    line2: lines.slice(1).join(", "),
    city: saved?.city ?? "",
    state: saved?.state ?? "",
    postalCode: saved?.postalCode ?? "",
    country: saved?.country ?? "",
    phone: saved?.phone ?? "",
    email: saved?.email ?? "",
  }));
  const set = (key: string) => (text: string) => setValues((v) => ({ ...v, [key]: text }));
  const empty = Object.values(values).every((v) => !v.trim());

  const save = async () => {
    const { line1, line2, ...rest } = values;
    const street = [line1, line2].map((l) => l!.trim()).filter(Boolean).join("\n");
    await saveAddress(profile, { ...rest, street, id: saved?.id }).catch(orWarn(null));
    onChanged();
    closeSettingsSheet();
  };
  const remove = async () => {
    if (!saved || !(await confirmDelete(t(`Delete this address?`), t(`It won't be offered in forms any more.`)))) return;
    await deleteAddress(profile, saved.id).catch(orWarn(undefined));
    onChanged();
    closeSettingsSheet();
  };

  return (
    <Sheet size="l" onClose={closeSettingsSheet}>
      <DialogTitle>{saved ? t(`Edit Address`) : t(`Add Address`)}</DialogTitle>
      <View style={SHEET_BODY}>
        <Group>
          {ADDRESS_FIELDS.map((f, i) => (
            <FormRow key={f.key} title={f.title}>
              <TextField value={values[f.key] ?? ""} onChangeText={set(f.key)} autoFocus={i === 0 && !saved} onSubmit={() => !empty && void save()} width={FIELD_WIDTH} />
            </FormRow>
          ))}
        </Group>
      </View>
      <SheetButtons canDelete={!!saved} onDelete={() => void remove()} onSave={() => void save()} saveDisabled={empty} />
    </Sheet>
  );
}

const MONTHS: Option<string>[] = [{ value: "", title: t(`Month`) }, ...Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), title: pad(i + 1) }))];
function yearOptions(current?: number): Option<string>[] {
  const now = new Date().getFullYear();
  const years = Array.from({ length: 16 }, (_, i) => now + i);
  if (current && !years.includes(current)) years.unshift(current);
  return [{ value: "", title: t(`Year`) }, ...years.map((y) => ({ value: String(y), title: String(y) }))];
}

const FIELD_WIDTH = 250;
const SHEET_BODY = { marginTop: space.xl } as const;
const ERROR = { marginTop: space.ml } as const;

function CardSheet({ profile, saved, onChanged }: { profile: string; saved?: SavedCard; onChanged: () => void }) {
  const [number, setNumber] = useState(saved ? null : "");
  const [name, setName] = useState(saved?.name ?? "");
  const [month, setMonth] = useState(saved?.expMonth ? String(saved.expMonth) : "");
  const [year, setYear] = useState(saved?.expYear ? String(saved.expYear) : "");
  const [error, setError] = useState("");
  const digits = (number ?? "").replace(/\D/g, "");

  const reveal = async () => {
    if (!saved) return;
    const full = await revealCardNumber(profile, saved.id).catch(() => null);
    if (full) setNumber(formatCardNumber(full));
  };
  const save = async () => {
    const card = { id: saved?.id, name: name.trim(), expMonth: month ? Number(month) : undefined, expYear: year ? Number(year) : undefined };
    const id = await saveCard(profile, card, number === null ? undefined : digits).catch(orWarn(null));
    if (!id) return setError(t(`That isn't a valid card number.`));
    onChanged();
    closeSettingsSheet();
  };
  const remove = async () => {
    if (!saved || !(await confirmDelete(t(`Delete this card?`), `Its number is removed from ${PLATFORM_TERMS.secretStore} too.`))) return;
    await deleteCard(profile, saved.id).catch(orWarn(undefined));
    onChanged();
    closeSettingsSheet();
  };

  return (
    <Sheet size="l" onClose={closeSettingsSheet}>
      <DialogTitle icon={saved ? <NetworkBadge network={saved.network} /> : undefined}>{saved ? `${cardNetworkName(saved.network)} •••• ${saved.last4}` : t(`Add Card`)}</DialogTitle>
      <View style={SHEET_BODY}>
        <Group>
          <FormRow title={t(`Card Number`)}>
            {number === null ? (
              <Box row center gap="xs">
                <Text>{`•••• •••• •••• ${saved?.last4 ?? ""}`}</Text>
                <Button variant="icon" icon="eye" size="m" onPress={() => void reveal()} tooltip={t(`Show Card Number`)} />
              </Box>
            ) : (
              <Box row center gap="xs">
                <TextField
                  value={number}
                  onChangeText={(t) => {
                    setError("");
                    setNumber(formatCardNumber(t.replace(/\D/g, "").slice(0, 19)));
                  }}
                  placeholder="1234 5678 9012 3456"
                  autoFocus={!saved}
                  width={saved ? FIELD_WIDTH - 28 : FIELD_WIDTH}
                />
                {saved ? <Button variant="icon" icon="doc.on.doc" size="m" onPress={() => copyText(digits)} tooltip={t(`Copy Card Number`)} /> : null}
              </Box>
            )}
          </FormRow>
          <FormRow title={t(`Name on Card`)}>
            <TextField value={name} onChangeText={setName} width={FIELD_WIDTH} />
          </FormRow>
          <FormRow title={t(`Expiration Date`)}>
            <Box row gap="s">
              <PopUp value={month} options={MONTHS} onChange={setMonth} minWidth={90} />
              <PopUp value={year} options={yearOptions(saved?.expYear)} onChange={setYear} minWidth={90} />
            </Box>
          </FormRow>
        </Group>
      </View>
      {error ? (
        <Text size="caption" tone="destructive" style={ERROR}>
          {error}
        </Text>
      ) : null}
      <SheetButtons
        canDelete={!!saved}
        onDelete={() => void remove()}
        onSave={() => void save()}
        saveDisabled={number !== null && digits.length < 12}
      />
    </Sheet>
  );
}

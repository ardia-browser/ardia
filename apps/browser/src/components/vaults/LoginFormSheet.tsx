import { consentToken } from "../../state/telemetry/choice";
import { useEffect, useRef, useState } from "react";
import { View, type TextInput } from "react-native";
import { showMenu } from "../../state/app/system";
import { currentEngineProfile } from "../../state/browser/current";
import { closeSettingsSheet } from "../../state/settings/sheet";
import type { SavedPassword } from "../../state/site/passwords";
import { noteArdiaLoginEdited, noteLoginCreatedInSettings, noteVaultLoginEdited } from "../../state/telemetry/vaultCounts";
import { codeSetupChoices } from "../../state/vaults/ardiaCodes";
import { useCodePageTab, useFrontPageTab, useSeveralProfiles } from "../../state/vaults/hooks";
import { endPasswordDraft, saveLoginEdit, saveNewArdiaLogin, startPasswordDraft } from "../../state/vaults/loginFormActions";
import type { VaultItem, VaultPasswordStyle } from "../../state/vaults/types";
import { ardiaLoginId, editOf, existingLogin, loginFormProblem, normalizeWebsite, type LoginFormProblem } from "../../state/vaults/loginForm";
import { siteLabel } from "../../state/vaults/originMatch";
import { codeLabels } from "../../state/vaults/standaloneCodesModel";
import { createStandaloneCode, forgetSetupCode, readSetupCode } from "../../state/vaults/standaloneCodes";
import { loadVaultItems } from "../../state/vaults/store";
import { GENERATOR_STYLES } from "../../state/vaults/menuModel";
import { Box, Button, Dialog, DialogActions, Expand, Segmented, space, Symbol, Text, useTheme, VaultPasswordField } from "../ui";
import { Favicon } from "../favicon/Favicon";
import { Group, ProfilePicker, Row } from "../settings/Form";
import { GENERATOR_COPY, itemUrl } from "./rowText";
import { BrandBadge } from "./VaultParts";
import { HeaderTile, SheetHeader } from "./VaultSignInParts";
import { FormRow, PlainField, SecretPlaceholder } from "./VaultFormFields";
import { VAULT_FORM, VAULT_SIGN_IN } from "./tokens";

type Mode = "password" | "code";

export type LoginFormTarget =
  | { kind: "new"; profileId: string; saved: readonly SavedPassword[]; onSaved: () => void; onShowExisting: (saved: SavedPassword) => void }
  | { kind: "ardia"; profile: string; saved: SavedPassword; list: readonly SavedPassword[]; hasCode: boolean; onSaved: () => void; onShowExisting: (saved: SavedPassword) => void }
  | { kind: "manager"; item: VaultItem };

type PendingCode = { token: string; title: string };

const MODES = [
  { value: "password" as const, title: "Password" },
  { value: "code" as const, title: "Verification Code" },
];

const PROBLEM_TEXT: Record<Exclude<LoginFormProblem, "duplicate">, string> = {
  website: "Enter a website, like example.com.",
  password: "Enter a password.",
  label: "Enter a label.",
  code: "Set up the code first.",
};

const SAVE_ERRORS: Record<string, string> = {
  invalid: "Check the website and username.",
  needsPassword: "Enter a password.",
  expired: "The code expired. Set it up again.",
  failed: "Couldn't save the password. Try again.",
  locked: "Unlock the password manager and try again.",
  notFound: "This login is no longer saved.",
  unsupported: "This password manager can't edit logins.",
};

function usePasswordDraft() {
  const [draft, setDraft] = useState<{ token: string; length: number } | null>(null);
  const live = useRef<string | null>(null);
  useEffect(() => {
    let alive = true;
    void startPasswordDraft().then((made) => {
      if (!made) return;
      if (!alive) return endPasswordDraft(made.token);
      live.current = made.token;
      setDraft(made);
    });
    return () => {
      alive = false;
      if (live.current) endPasswordDraft(live.current);
    };
  }, []);
  const generate = async (style: VaultPasswordStyle) => {
    const made = await startPasswordDraft(style);
    if (!made) return false;
    live.current = made.token;
    setDraft(made);
    return true;
  };
  const setLength = (length: number) => setDraft((d) => (d ? { ...d, length } : d));
  return { draft, generate, setLength };
}

function titleOf(target: LoginFormTarget, mode: Mode) {
  if (target.kind === "new") return mode === "code" ? "New Verification Code" : "New Password";
  if (target.kind === "ardia") return siteLabel(target.saved.origin);
  return siteLabel(itemUrl(target.item)) || target.item.title;
}

export function LoginFormSheet({ target, initialMode = "password" }: { target: LoginFormTarget; initialMode?: Mode }) {
  const theme = useTheme();
  const editing = target.kind !== "new";
  const [mode, setMode] = useState<Mode>(target.kind === "new" ? initialMode : "password");
  const startWebsite = target.kind === "ardia" ? target.saved.origin : target.kind === "manager" ? itemUrl(target.item) : "";
  const startUsername = target.kind === "ardia" ? target.saved.username : target.kind === "manager" ? target.item.username : "";
  const [website, setWebsite] = useState(startWebsite);
  const [username, setUsername] = useState(startUsername);
  const [profileId, setProfileId] = useState(target.kind === "new" ? target.profileId : "");
  const [revealed, setRevealed] = useState(false);
  const [typedPassword, setTypedPassword] = useState(false);
  const { draft, generate, setLength } = usePasswordDraft();
  const [code, setCode] = useState<PendingCode | null>(null);
  const [removeCode, setRemoveCode] = useState(false);
  const [label, setLabel] = useState("");
  const [labelTyped, setLabelTyped] = useState(false);
  const [issuer, setIssuer] = useState("");
  const [codeWebsite, setCodeWebsite] = useState("");
  const [problem, setProblem] = useState("");
  const [duplicate, setDuplicate] = useState<SavedPassword | null>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const websiteInput = useRef<TextInput>(null);
  const usernameInput = useRef<TextInput>(null);
  const passwordInput = useRef<{ focus: () => void }>(null);
  const labelInput = useRef<TextInput>(null);
  const issuerInput = useRef<TextInput>(null);
  const codeWebsiteInput = useRef<TextInput>(null);
  const tabFrom = (index: number) => (back: boolean) => {
    const order = mode === "code" ? [labelInput, issuerInput, codeWebsiteInput] : [websiteInput, usernameInput, passwordInput];
    order[(index + (back ? order.length - 1 : 1)) % order.length]!.current?.focus();
  };
  const front = useFrontPageTab();
  const severalProfiles = useSeveralProfiles();
  const [focus, setFocus] = useState<string | null>(null);
  const focusOn = (name: string) => (on: boolean) => setFocus((now) => (on ? name : now === name ? null : now));

  useEffect(() => () => void (code && forgetSetupCode(code.token)), [code?.token]);

  const hadCode = target.kind === "ardia" ? target.hasCode : target.kind === "manager" ? target.item.hasTotp === true : false;
  const canCode = target.kind !== "manager" || target.item.provider !== "protonpass";
  const passwordLength = draft?.length ?? 0;
  const saved = target.kind === "new" ? target.saved : target.kind === "ardia" ? target.list : [];
  const self = target.kind === "ardia" ? target.saved : null;
  const blocker = loginFormProblem(
    mode === "code"
      ? { mode, website: codeWebsite, label, hasCode: !!code, saved }
      : { mode, website, username, passwordLength, saved, self, keepsPassword: editing },
  );
  const changed = target.kind === "new" || website !== startWebsite || username !== startUsername || passwordLength > 0 || !!code || removeCode;

  const siteOrigin = mode === "code" ? normalizeWebsite(codeWebsite) : normalizeWebsite(website);
  const pageTab = useCodePageTab(siteOrigin);
  const scanTab = mode === "code" && !siteOrigin ? front : pageTab && siteOrigin ? { tabId: pageTab, origin: siteOrigin } : null;

  const setUpCode = async () => {
    setProblem("");
    const readOrigin = siteOrigin ?? "";
    const choices = codeSetupChoices(scanTab?.origin ?? readOrigin, scanTab?.tabId ?? null);
    const picked = await showMenu(choices);
    const choice = choices.find((c) => c.id === picked);
    if (!choice) return;
    const result = await readSetupCode(choice.id, choice.id === "page" ? scanTab!.origin : readOrigin, choice.id === "page" ? scanTab!.tabId : null);
    if ("outcome" in result) return setProblem(result.outcome.ok ? "" : (result.outcome.error ?? ""));
    const names = codeLabels(result.read);
    if (code) forgetSetupCode(code.token);
    setCode({ token: result.read.token, title: [names.issuer, names.label].filter(Boolean).join(" · ") || "Ready" });
    setRemoveCode(false);
    if (mode === "code" && !labelTyped) {
      setLabel(names.label);
      setIssuer(names.issuer);
    }
    requestAnimationFrame(() => (mode === "code" ? labelInput : websiteInput).current?.focus());
  };

  const showDuplicate = (found: SavedPassword) => {
    setDuplicate(found);
    setProblem("A password for this username is already saved.");
  };

  const save = async () => {
    if (saving.current || busy) return;
    setTried(true);
    setDuplicate(null);
    if (blocker === "duplicate") {
      const found = existingLogin(saved, siteOrigin ?? "", username, self) as SavedPassword | null;
      return found ? showDuplicate(found) : setProblem("A password for this username is already saved.");
    }
    if (blocker) return setProblem(PROBLEM_TEXT[blocker]);
    if (!changed) return closeSettingsSheet();
    saving.current = true;
    setBusy(true);
    setProblem("");
    const done = await submit().finally(() => {
      saving.current = false;
    });
    setBusy(false);
    if (done) closeSettingsSheet();
  };

  const submit = async (): Promise<boolean> => {
    const consent = consentToken();
    if (target.kind === "new" && mode === "code") {
      const outcome = await createStandaloneCode({ token: code!.token, label, issuer, website: normalizeWebsite(codeWebsite) });
      if (outcome.ok) setCode(null);
      else setProblem(outcome.error ?? "");
      return outcome.ok;
    }
    if (target.kind === "new") {
      const profile = currentEngineProfile(profileId);
      const result = await saveNewArdiaLogin({ website: siteOrigin!, username: username.trim(), passwordDraft: draft!.token, profile, ...(code ? { codeToken: code.token } : {}) });
      if (result?.saved) {
        noteLoginCreatedInSettings(result.codeAdded, consent);
        if (code) setCode(null);
        target.onSaved();
        void loadVaultItems("ardia", true);
        return true;
      }
      if (result?.error === "declined") return false;
      if (result?.error === "exists") {
        const found = existingLogin(target.saved, siteOrigin!, username) ?? { origin: siteOrigin!, username: username.trim() };
        showDuplicate(found as SavedPassword);
        return false;
      }
      setProblem(SAVE_ERRORS[result?.error ?? "failed"] ?? SAVE_ERRORS.failed!);
      return false;
    }
    const edit = editOf({ website: startWebsite, username: startUsername }, { website, username, passwordDraft: passwordLength > 0 ? draft?.token : undefined, codeToken: code?.token, removeCode });
    const provider = target.kind === "ardia" ? "ardia" : target.item.provider;
    const id = target.kind === "ardia" ? ardiaLoginId(target.profile, target.saved.origin, target.saved.username) : target.item.id;
    const result = await saveLoginEdit(provider, id, target.kind === "ardia" ? { ...edit, profile: target.profile } : edit);
    if (result?.edited) {
      if (code) setCode(null);
      if (target.kind === "ardia") {
        noteArdiaLoginEdited(consent);
        target.onSaved();
      } else noteVaultLoginEdited(consent);
      void loadVaultItems(provider, true);
      return true;
    }
    if (result?.error === "declined") return false;
    setProblem(result?.message ?? SAVE_ERRORS[result?.error ?? "failed"] ?? SAVE_ERRORS.failed!);
    return false;
  };

  const pickGenerator = async () => {
    const picked = await showMenu(GENERATOR_STYLES.map((style) => ({ id: style, title: [GENERATOR_COPY[style].title, GENERATOR_COPY[style].detail].filter(Boolean).join(", ") })));
    if (!picked || !(await generate(picked as VaultPasswordStyle))) return;
    setTypedPassword(true);
    setRevealed(true);
    requestAnimationFrame(() => passwordInput.current?.focus());
  };

  const icon = (
    <HeaderTile>
      {target.kind === "manager" ? (
        itemUrl(target.item) ? <Favicon url={itemUrl(target.item)} size={VAULT_SIGN_IN.tileIcon} /> : <BrandBadge provider={target.item.provider} size="l" />
      ) : target.kind === "ardia" ? (
        <Favicon url={target.saved.origin} size={VAULT_SIGN_IN.tileIcon} />
      ) : (
        <Symbol name={mode === "code" ? "clock.badge.checkmark" : "key.fill"} size={VAULT_SIGN_IN.tileGlyph} color={theme.textSecondary} style={ICON_GLYPH} />
      )}
    </HeaderTile>
  );

  const flagged = (which: LoginFormProblem) => tried && blocker === which;
  const codeRow = (
    <Row title="Verification Code">
      {code ? (
        <Box row gap="xs" center>
          <Text numberOfLines={1} style={CODE_TITLE}>
            {code.title}
          </Text>
          <Button variant="icon" icon="xmark.circle.fill" size="m" tooltip="Remove Code" onPress={() => (forgetSetupCode(code.token), setCode(null))} />
        </Box>
      ) : removeCode ? (
        <Box row gap="xs" center>
          <Text tone="textSecondary">Removed</Text>
          <Button title="Undo" onPress={() => setRemoveCode(false)} />
        </Box>
      ) : hadCode ? (
        <Box row gap="xs" center>
          <Button title="Replace…" disabled={busy} onPress={() => void setUpCode()} />
          <Button title="Remove" kind="destructive" disabled={busy} onPress={() => setRemoveCode(true)} />
        </Box>
      ) : (
        <Button title="Set Up…" disabled={busy} onPress={() => void setUpCode()} />
      )}
    </Row>
  );

  return (
    <Dialog width="m" maxHeight="90%" onDismiss={closeSettingsSheet} onSubmit={() => void save()} focusInside>
      <SheetHeader icon={icon} title={titleOf(target, mode)} />
      {target.kind === "new" ? (
        <View style={MODE_ROW}>
          <Segmented options={MODES} value={mode} onChange={(next) => (setMode(next), setProblem(""), setTried(false))} />
        </View>
      ) : null}
      <View style={BODY}>
        {mode === "password" ? (
          <Group>
            <FormRow label="Website" focused={focus === "website"} invalid={flagged("website")}>
              <PlainField inputRef={websiteInput} label="Website" onTab={tabFrom(0)} value={website} onChangeText={(t) => (setWebsite(t), setDuplicate(null))} placeholder="example.com" autoFocus={!editing} onSubmit={() => void save()} onEscape={closeSettingsSheet} onFocusChange={focusOn("website")} />
            </FormRow>
            <FormRow label="Username" focused={focus === "username"} invalid={flagged("duplicate")}>
              <PlainField inputRef={usernameInput} label="Username" onTab={tabFrom(1)} value={username} onChangeText={(t) => (setUsername(t), setDuplicate(null))} placeholder="Optional" autoFocus={editing} onSubmit={() => void save()} onEscape={closeSettingsSheet} onFocusChange={focusOn("username")} />
            </FormRow>
            <FormRow label="Password" focused={focus === "password"} invalid={flagged("password")}>
              <Box row gap="xs" center>
                <View style={PASSWORD_CELL}>
                  {passwordLength === 0 ? <SecretPlaceholder text={editing && !typedPassword ? "Unchanged" : "Required"} /> : null}
                  {draft ? (
                    <VaultPasswordField
                      ref={passwordInput}
                      tabs
                      onTab={tabFrom(2)}
                      draft={draft.token}
                      revealed={revealed}
                      bordered={false}
                      label="Password"
                      onFocusChange={focusOn("password")}
                      style={PASSWORD}
                      onEdit={(length) => (setLength(length), setTypedPassword(length > 0))}
                      onSubmit={() => void save()}
                      onEscape={closeSettingsSheet}
                    />
                  ) : null}
                </View>
                <Button variant="icon" icon={revealed ? "eye.slash" : "eye"} size="m" tooltip={revealed ? "Hide Password" : "Show Password"} onPress={() => setRevealed(!revealed)} />
                <Button variant="icon" icon="key" size="m" tooltip="Generate Password" onPress={() => void pickGenerator()} />
              </Box>
            </FormRow>
            {target.kind === "new" && severalProfiles ? <ProfileRow value={profileId} onChange={setProfileId} /> : null}
            {canCode ? codeRow : null}
          </Group>
        ) : (
          <Group>
            <Row title="Code">
              {code ? (
                <Box row gap="xs" center>
                  <Text numberOfLines={1} style={CODE_TITLE}>
                    {code.title}
                  </Text>
                  <Button title="Change…" onPress={() => void setUpCode()} />
                </Box>
              ) : (
                <Button title="Set Up…" kind={tried && blocker === "code" ? "primary" : "default"} onPress={() => void setUpCode()} />
              )}
            </Row>
            <FormRow label="Label" focused={focus === "label"} invalid={flagged("label")}>
              <PlainField inputRef={labelInput} label="Label" onTab={tabFrom(0)} value={label} onChangeText={(t) => (setLabel(t), setLabelTyped(true))} placeholder="Required" autoFocus={!editing} onSubmit={() => void save()} onEscape={closeSettingsSheet} onFocusChange={focusOn("label")} />
            </FormRow>
            <FormRow label="Issuer" focused={focus === "issuer"}>
              <PlainField inputRef={issuerInput} label="Issuer" onTab={tabFrom(1)} value={issuer} onChangeText={setIssuer} placeholder="Optional" onSubmit={() => void save()} onEscape={closeSettingsSheet} onFocusChange={focusOn("issuer")} />
            </FormRow>
            <FormRow label="Website" focused={focus === "codeWebsite"} invalid={flagged("website")}>
              <PlainField inputRef={codeWebsiteInput} label="Website" onTab={tabFrom(2)} value={codeWebsite} onChangeText={setCodeWebsite} placeholder="Optional" onSubmit={() => void save()} onEscape={closeSettingsSheet} onFocusChange={focusOn("codeWebsite")} />
            </FormRow>
          </Group>
        )}
        <Expand open={!!problem} gap={space.ml}>
          <Box row gap="m" center>
            <Text size="caption" tone="destructive" style={PROBLEM}>
              {problem}
            </Text>
            {duplicate && target.kind !== "manager" ? <Button title="Show Password" onPress={() => target.onShowExisting(duplicate)} /> : null}
          </Box>
        </Expand>
      </View>
      <DialogActions>
        <Button title="Cancel" disabled={busy} onPress={closeSettingsSheet} />
        <Button title="Save" kind="primary" busy={busy} onPress={() => void save()} />
      </DialogActions>
    </Dialog>
  );
}

function ProfileRow({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const several = useSeveralProfiles();
  if (!several) return null;
  return (
    <Row title="Profile">
      <ProfilePicker value={value} onChange={onChange} />
    </Row>
  );
}

const BODY = { marginTop: space.xl } as const;
const MODE_ROW = { marginTop: space.xl, alignItems: "center" } as const;
const PASSWORD_CELL = { flex: 1, height: VAULT_FORM.fieldHeight, justifyContent: "center" } as const;
const PASSWORD = { flex: 1, height: VAULT_FORM.fieldHeight } as const;
const PROBLEM = { flex: 1 } as const;
const CODE_TITLE = { maxWidth: VAULT_FORM.codeTitle } as const;
const ICON_GLYPH = { width: VAULT_SIGN_IN.tileIcon, height: VAULT_SIGN_IN.tileIcon } as const;

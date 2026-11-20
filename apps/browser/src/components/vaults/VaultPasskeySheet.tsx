import { useEffect, useRef, type ReactNode } from "react";
import { Image, Pressable, View } from "react-native";
import { showMenu } from "../../state/app/system";
import { siteLabel } from "../../state/vaults/originMatch";
import { answerPasskeySheet, choosePasskeyTarget, selectPasskey, usePasskeys, type PasskeySheet } from "../../state/vaults/passkeys";
import type { VaultPasskey } from "../../state/vaults/types";
import { PromptBody } from "../site/Prompts";
import { usePromptInputGuard, Well } from "../site/PromptParts";
import { Box, Button, Expand, PanelCloseButton, Popover, POPOVER_WIDTH, PopoverValue, space, Symbol, Text, usePopoverPresence, useTheme } from "../ui";
import { useManagerName, VaultAppIcon } from "./VaultParts";
import { useSiteTokens } from "../site/tokens";
import { usePasskeyExtensions } from "../../state/vaults/passkeySources";
import { VAULT_MENU } from "./tokens";
import { refreshVaultBiometrics, useVaultBiometrics } from "../../state/vaults/store";

const hostOf = (origin: string) => origin.replace(/^[a-z]+:\/\//, "").replace(/:\d+$/, "");

const accountLine = (p: { userName?: string; displayName?: string }) => p.userName || p.displayName || "No Username";

function titleOf(sheet: PasskeySheet, site: string) {
  if (sheet.kind === "get") return `Sign In to ${site}?`;
  return sheet.exists ? "Passkey Already Saved" : `Save a Passkey for ${site}?`;
}

function messageOf(sheet: PasskeySheet, site: string, targetName: string, touchID: boolean) {
  const check = touchID ? "Touch ID" : "your login password";
  if (sheet.kind === "get") return sheet.passkeys.length > 1 ? `Choose a passkey. You'll confirm with ${check}.` : `You'll confirm with ${check}.`;
  if (sheet.exists) return `You already have a passkey for ${accountLine(sheet)} on ${site}.`;
  if (sheet.private) return `Saves to ${targetName}, and stays there after this window closes. You'll sign in with ${check}.`;
  return touchID ? `Saves to ${targetName}. You'll sign in with Touch ID, no password needed.` : `Saves to ${targetName}. You'll sign in with your login password.`;
}

function PasskeyTile({ provider }: { provider: string }) {
  const { well } = useSiteTokens();
  return <VaultAppIcon provider="" symbol="key.fill" neutral badge={{ provider, ground: well }} />;
}

function PasskeyRow({ passkey, selected, many, onPress }: { passkey: VaultPasskey; selected: boolean; many: boolean; onPress: () => void }) {
  const theme = useTheme();
  const nameOf = useManagerName();
  return (
    <Pressable onPress={onPress} disabled={!many}>
      <Well>
        <Box row gap="ml" center style={LEFT}>
          <PasskeyTile provider={passkey.provider} />
          <View style={FILL}>
            <Text lines={1} size="small" weight="medium">
              {accountLine(passkey)}
            </Text>
            <Text lines={1} size="caption" tone="textSecondary">
              {passkey.displayName && passkey.displayName !== passkey.userName ? passkey.displayName : `Passkey in ${nameOf(passkey.provider)}`}
            </Text>
          </View>
          {many ? <Symbol name={selected ? "checkmark.circle.fill" : "circle"} size={15} color={selected ? theme.accent : theme.textTertiary} /> : null}
        </Box>
      </Well>
    </Pressable>
  );
}

function SourceRow({ tile, title, detail, onPress }: { tile: ReactNode; title: string; detail: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable onPress={onPress}>
      <Well>
        <Box row gap="ml" center style={LEFT}>
          {tile}
          <View style={FILL}>
            <Text lines={1} size="small" weight="medium">
              {title}
            </Text>
            <Text lines={1} size="caption" tone="textSecondary">
              {detail}
            </Text>
          </View>
          <Symbol name="chevron.right" size={12} color={theme.textTertiary} />
        </Box>
      </Well>
    </Pressable>
  );
}

function ExtensionTile({ icon }: { icon: string | undefined }) {
  const size = VAULT_MENU.icon.box;
  if (!icon) return <VaultAppIcon provider="" symbol="puzzlepiece.extension" neutral />;
  return <Image source={{ uri: icon }} style={{ width: size, height: size }} />;
}

function PasskeyChooser({ sheet, site, choose }: { sheet: PasskeySheet; site: string; choose: (choice: `source:${string}`) => void }) {
  const touchID = useVaultBiometrics((s) => s.available);
  const installed = usePasskeyExtensions();
  const iconOf = (id: string) => installed.find((e) => e.id === id)?.icon;
  const count = sheet.kind === "get" ? sheet.passkeys.length : 0;
  return (
    <Box gap="s">
      {sheet.ardia !== false ? (
        <SourceRow
          tile={<PasskeyTile provider="ardia" />}
          title="Ardia"
          detail={sheet.kind === "create" ? `Save it in Ardia, with ${touchID ? "Touch ID" : "your login password"}` : `${count} passkey${count === 1 ? "" : "s"} for ${site}`}
          onPress={() => choose("source:ardia")}
        />
      ) : null}
      {(sheet.extensions ?? []).map((e) => (
        <SourceRow key={e.id} tile={<ExtensionTile icon={iconOf(e.id)} />} title={e.name} detail="Extension" onPress={() => choose(`source:ext:${e.id}`)} />
      ))}
      <SourceRow
        tile={<VaultAppIcon provider="" symbol="key" neutral />}
        title="Security Key or Phone"
        detail="Chrome"
        onPress={() => choose("source:chrome")}
      />
    </Box>
  );
}

export function VaultPasskeySheet({ tabId, right, top }: { tabId: string; right: number; top: number }) {
  const live = usePasskeys((s) => s.sheets[tabId] ?? null);
  const last = useRef(live);
  if (live) last.current = live;
  const presence = usePopoverPresence(!!live);
  const sheet = live ?? (presence.shown ? last.current : null);
  const guard = usePromptInputGuard(sheet?.seq);
  const nameOf = useManagerName();
  const touchID = useVaultBiometrics((s) => s.available);
  useEffect(() => refreshVaultBiometrics(), [sheet?.seq]);
  if (!sheet) return null;
  const site = siteLabel(sheet.origin);
  const host = hostOf(sheet.origin);
  const targetName = nameOf(sheet.target);
  const pickTarget = async () => {
    const choice = await showMenu(sheet.targets.map((id) => ({ id, title: nameOf(id), checked: id === sheet.target })));
    if (choice) choosePasskeyTarget(tabId, choice);
  };
  const answer = (choice: Parameters<typeof answerPasskeySheet>[1]) => void answerPasskeySheet(tabId, choice);
  const otherOptions = async () => {
    const extensions = sheet.extensions ?? [];
    if (!sheet.system && !extensions.length) return answer("other");
    const choice = await showMenu([
      ...extensions.map((e) => ({ id: `source:ext:${e.id}`, title: `${e.name}…` })),
      ...(sheet.system ? [{ id: "system", title: "iCloud Keychain or Another App…" }] : []),
      { id: "other", title: "Security Key or Phone…" },
    ]);
    if (choice === "system" || choice === "other") answer(choice);
    else if (choice?.startsWith("source:ext:")) answer(choice as `source:${string}`);
  };
  const many = sheet.kind === "get" && sheet.passkeys.length > 1;
  const primaryTitle = sheet.kind === "get" ? (sheet.busy ? "Signing In…" : "Continue") : sheet.exists ? "OK" : sheet.busy ? "Saving…" : "Save";
  const primary = () => answer(sheet.kind === "get" ? "use" : sheet.exists ? "existing" : "save");
  return (
    <Popover key={sheet.seq} width={POPOVER_WIDTH.m} top={top} right={right} modal={false} closing={!live} onClosed={presence.onClosed}>
      <View>
        <PromptBody
          icons={["person.badge.key"]}
          title={sheet.choose ? (sheet.kind === "get" ? `Sign In to ${site} With…` : `Save a Passkey for ${site} In…`) : titleOf(sheet, site)}
          message={sheet.choose ? (sheet.kind === "get" ? "Choose where your passkey is." : "Choose where to keep it.") : messageOf(sheet, site, targetName, touchID)}
          detail={
            <>
              {sheet.choose ? (
                <PasskeyChooser sheet={sheet} site={site} choose={(choice) => answer(choice)} />
              ) : sheet.kind === "get" ? (
                <Box gap="s">
                  {sheet.passkeys.map((p) => (
                    <PasskeyRow key={p.id} passkey={p} selected={p.id === sheet.selected} many={many} onPress={guard(() => selectPasskey(tabId, p.id))} />
                  ))}
                </Box>
              ) : (
                <Well>
                  <Box row gap="ml" center style={LEFT}>
                    <PasskeyTile provider={sheet.target} />
                    <View style={FILL}>
                      <Text lines={1} size="small" weight="medium">
                        {accountLine(sheet)}
                      </Text>
                      <Text lines={1} size="caption" tone="textSecondary">
                        {host === sheet.rpId ? site : `${site} for ${sheet.rpId}`}
                      </Text>
                    </View>
                  </Box>
                </Well>
              )}
              {sheet.kind === "create" && !sheet.choose && !sheet.exists && sheet.targetNote ? (
                <Text size="caption" tone="textSecondary">
                  {sheet.targetNote}
                </Text>
              ) : null}
              {sheet.kind === "create" && !sheet.choose && !sheet.exists && sheet.targets.length > 1 ? (
                <Box row center style={BETWEEN}>
                  <Text size="small" tone="textSecondary">
                    Save To
                  </Text>
                  <PopoverValue title={targetName} onPress={guard(() => void pickTarget())} />
                </Box>
              ) : null}
              <Expand open={!!sheet.error} gap={space.ml}>
                <Text size="caption" tone="destructive">
                  {sheet.error}
                </Text>
              </Expand>
            </>
          }
        >
          {sheet.choose ? null : <Button variant="pill" title="Other Options…" onPress={guard(() => void otherOptions())} />}
          {sheet.exists ? null : <Button variant="pill" title={sheet.kind === "get" || sheet.choose ? "Cancel" : "Not Now"} onPress={guard(() => answer("cancel"))} />}
          {sheet.choose ? null : (
            <View pointerEvents={sheet.busy ? "none" : "auto"}>
              <Button variant="pill" title={primaryTitle} reserve={sheet.kind === "get" ? GET_TITLES : SAVE_TITLES} primary onPress={guard(primary)} />
            </View>
          )}
        </PromptBody>
        <PanelCloseButton onPress={guard(() => answer("cancel"))} />
      </View>
    </Popover>
  );
}

const FILL = { flex: 1, minWidth: 0 } as const;
const LEFT = { justifyContent: "flex-start" } as const;
const BETWEEN = { justifyContent: "space-between" } as const;
const SAVE_TITLES = ["Save", "Saving…", "OK"] as const;
const GET_TITLES = ["Continue", "Signing In…"] as const;

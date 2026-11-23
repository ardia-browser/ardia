import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { showMenu } from "../../state/app/system";
import { useVaultLogins, useVaultSaveOffer } from "../../state/vaults/hooks";
import { siteLabel } from "../../state/vaults/originMatch";
import { passwordLetsSave, stageOfferPassword, type VaultPasswordDraft } from "../../state/vaults/savePassword";
import { prefilledUsername, useRankedUsernames } from "../../state/vaults/usernameSuggestions";
import { canSaveVaultOffer, chooseVaultTarget, dismissVaultOffer, editVaultOfferUsername, saveVaultOffer, setVaultOfferUsername } from "../../state/vaults/saveOffer";
import { webviews } from "../../state/tabs/webviewHandles";
import { Favicon } from "../favicon/Favicon";
import { PromptBody } from "../site/Prompts";
import { usePromptInputGuard, Well } from "../site/PromptParts";
import { Box, Button, Expand, opacity, PanelCloseButton, Popover, POPOVER_WIDTH, PopoverValue, radius, space, Text, usePopoverPresence, useTheme, VaultPasswordField } from "../ui";
import { BrandBadge, useManagerName } from "./VaultParts";
import { LabeledField, VaultUsernameField } from "./VaultUsernameField";
import { VAULT_SAVE, VAULT_SIGN_IN } from "./tokens";

function SavePasswordField({ tabId, origin, seq, onLength, onFocusInside, onSubmit, onEscape }: { tabId: string; origin: string; seq: number; onLength: (length: number) => void; onFocusInside: () => void; onSubmit: () => void; onEscape: () => void }) {
  const [draft, setDraft] = useState<VaultPasswordDraft | null>(null);
  const [revealed, setRevealed] = useState(false);
  const theme = useTheme();
  useEffect(() => {
    let live = true;
    setDraft(null);
    void stageOfferPassword(tabId, origin).then((staged) => {
      if (!live) return;
      setDraft(staged);
      if (staged.token) onLength(staged.length);
    });
    return () => {
      live = false;
    };
  }, [tabId, origin, seq]);
  if (!draft?.token) return null;
  return (
    <LabeledField label="Password">
      <Box row gap="xs" center>
        <View style={[PASSWORD_BOX, { backgroundColor: theme.field, borderColor: theme.fieldBorder }]}>
          <VaultPasswordField draft={draft.token} revealed={revealed} bordered={false} label="Password" style={PASSWORD} onEdit={(next) => (onFocusInside(), onLength(next))} onSubmit={() => (onFocusInside(), onSubmit())} onEscape={() => (onFocusInside(), onEscape())} />
        </View>
        <Button variant="icon" icon={revealed ? "eye.slash" : "eye"} size="m" tooltip={revealed ? "Hide Password" : "Show Password"} onPress={() => setRevealed(!revealed)} />
      </Box>
    </LabeledField>
  );
}

export function VaultSaveOffer({ tabId, right, top }: { tabId: string; right: number; top: number }) {
  const live = useVaultSaveOffer(tabId);
  const last = useRef(live);
  if (live) last.current = live;
  const presence = usePopoverPresence(!!live);
  const offer = live ?? (presence.shown ? last.current : null);
  const nameOf = useManagerName();
  const guard = usePromptInputGuard(offer?.seq);
  const ranked = useRankedUsernames(useVaultLogins({ enabled: !!offer }), true);
  const [password, setPassword] = useState<{ seq: number; length: number } | null>(null);
  const editing = !!offer?.editing;
  const focusedInside = useRef(false);
  if (editing) focusedInside.current = true;
  const closed = () => {
    presence.onClosed();
    if (!focusedInside.current) return;
    focusedInside.current = false;
    void webviews.get(tabId)?.focus();
  };
  useEffect(() => {
    if (!offer || !editing || offer.username.trim()) return;
    const best = prefilledUsername(offer.username, ranked);
    if (best) setVaultOfferUsername(tabId, best);
  }, [offer?.seq, editing, ranked]);
  if (!offer) return null;
  const site = siteLabel(offer.origin);
  const length = password?.seq === offer.seq ? password.length : null;
  const ready = canSaveVaultOffer(offer) && passwordLetsSave(length);
  const save = () => ready && void saveVaultOffer(tabId);
  const target = nameOf(offer.target);
  const updating = !!offer.update;
  const pickTarget = async () => {
    const choice = await showMenu(offer.targets.map((id) => ({ id, title: nameOf(id), checked: id === offer.target })));
    if (choice) chooseVaultTarget(tabId, choice);
  };
  return (
    <Popover key={offer.seq} width={POPOVER_WIDTH.m} top={top} right={right} modal={false} closing={!live} onClosed={closed}>
      <View>
        <PromptBody
          icons={["key.fill"]}
          title={updating ? `Update Password for ${site}?` : `Save Password for ${site}?`}
          message={updating || offer.targets.length > 1 ? null : `Saves to ${target}`}
          detail={
            <>
              {offer.editing ? (
                <VaultUsernameField
                  value={offer.username}
                  ranked={ranked}
                  onChange={(text) => setVaultOfferUsername(tabId, text)}
                  autoFocus
                  onSubmit={save}
                  onEscape={() => dismissVaultOffer(tabId)}
                />
              ) : (
                <Well>
                  <Box row gap="ml" center style={LEFT}>
                    <Favicon url={offer.origin} />
                    <Pressable style={FILL} disabled={updating} accessibilityRole={updating ? "text" : "button"} accessibilityLabel={updating ? offer.username || "No Username" : `Edit Username, ${offer.username || "No Username"}`} onPress={guard(() => editVaultOfferUsername(tabId))}>
                      <View tooltip={updating ? undefined : "Edit Username"}>
                        <Text lines={1} size="small" weight="medium">
                          {offer.username || "No Username"}
                        </Text>
                        <Text lines={1} size="caption" tone="textSecondary">
                          {site}
                        </Text>
                      </View>
                    </Pressable>
                    <BrandBadge provider={offer.target} tooltip={target} />
                  </Box>
                </Well>
              )}
              <SavePasswordField
                tabId={tabId}
                origin={offer.origin}
                seq={offer.seq}
                onLength={(next) => setPassword({ seq: offer.seq, length: next })}
                onFocusInside={() => (focusedInside.current = true)}
                onSubmit={save}
                onEscape={() => dismissVaultOffer(tabId)}
              />
              {offer.targets.length > 1 ? (
                <Box row center style={BETWEEN}>
                  <Text size="small" tone="textSecondary">
                    Save To
                  </Text>
                  <PopoverValue title={target} onPress={guard(() => void pickTarget())} />
                </Box>
              ) : null}
              <Expand open={!!offer.error} gap={space.ml}>
                <Text size="caption" tone="destructive">
                  {offer.error}
                </Text>
              </Expand>
            </>
          }
        >
          <Button variant="pill" title="Not Now" onPress={guard(() => dismissVaultOffer(tabId))} />
          <View pointerEvents={ready ? "auto" : "none"} accessibilityState={{ disabled: !ready }} style={ready ? undefined : DIMMED}>
            <Button
              variant="pill"
              title={updating ? "Update" : "Save"}
              primary
              onPress={guard(() => void saveVaultOffer(tabId))}
            />
          </View>
        </PromptBody>
        <PanelCloseButton onPress={guard(() => dismissVaultOffer(tabId))} />
      </View>
    </Popover>
  );
}

const FILL = { flex: 1, minWidth: 0 } as const;
const LEFT = { justifyContent: "flex-start" } as const;
const BETWEEN = { justifyContent: "space-between" } as const;
const DIMMED = { opacity: opacity.disabled } as const;
const PASSWORD_BOX = { flex: 1, height: VAULT_SAVE.passwordHeight, borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth * 2, paddingHorizontal: space.m, justifyContent: "center" } as const;
const PASSWORD = { height: VAULT_SIGN_IN.secretHeight } as const;

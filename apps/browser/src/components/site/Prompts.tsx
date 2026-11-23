import { setSiteSetting } from "../../state/site/siteSettings";
import { answerAutofillPrompt, answerExternalApp, answerPasswordPrompt } from "../../state/site/prompts";
import { acceptVerificationCode, declineVerificationCode, verificationCodeCopy } from "../../state/site/verificationCodes";
import {
  type AutofillPromptAnswer,
  type PasswordPromptAnswer,
  patchPage,
  pageOf,
  setPopover,
  usePage,
  usePages,
} from "../../state/tabs/pageState";
import { dismissPopoverByPress } from "../../state/tabs/popoverDismiss";
import { useState } from "react";
import { View } from "react-native";
import { space } from "../ui/tokens";
import { webviews } from "../../state/tabs/webviewHandles";
import { currentEngineProfile, currentTab } from "../../state/browser/current";
import { Box, Button, DialogActions, MenuRow, MenuSeparator, PANEL, PanelCloseButton, Popover, POPOVER_WIDTH, Text, tracking, usePopoverPresenceOf, useStillOpen, whileOpen } from "../ui";
import { answerPermission, describePermission } from "../../state/site/permissions";
import { hostOrOrigin } from "../../lib/url";
import { CheckRow, PromptHeader, usePromptInputGuard, Well } from "./PromptParts";

export function PromptBody({
  icons,
  image,
  title,
  message,
  detail,
  children,
}: {
  icons: string[];
  image?: string | null;
  title: string;
  message?: string | null;
  detail?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <View style={{ padding: PANEL.inset }}>
      <Box gap="ml">
        <PromptHeader icons={icons} image={image} title={title} message={message} />
        {detail}
      </Box>
      <DialogActions>{children}</DialogActions>
    </View>
  );
}

export const PERMISSION_PROMPT_WIDTH = POPOVER_WIDTH.s;
export const EXTERNAL_APP_WIDTH = POPOVER_WIDTH.m;

export function PermissionPrompt({ tabId, left, top }: { tabId: string; left: number; top: number }) {
  const live = usePage(tabId, (p) => p.permission);
  const { shown: request, closing, onClosed } = usePopoverPresenceOf(live);
  const inputGuard = usePromptInputGuard(live?.id);
  if (!request) return null;
  const guard = <A extends unknown[]>(action: (...args: A) => void) => whileOpen(closing, () => pageOf(tabId).permission?.id === request.id)(inputGuard(action));
  const { icons, question } = describePermission(request);
  return (
    <Popover key={request.id} width={PERMISSION_PROMPT_WIDTH} top={top} left={left} modal={false} closing={closing} onClosed={onClosed}>
      <View>
        <PromptBody icons={icons} title={question} message="Click the lock to change this any time">
          <Button variant="pill" title="Don't Allow" onPress={guard(() => answerPermission(tabId, request.id, "deny"))} />
          <Button variant="pill" title="Allow" primary onPress={guard(() => answerPermission(tabId, request.id, "accept"))} />
        </PromptBody>
        <PanelCloseButton onPress={guard(() => answerPermission(tabId, request.id, "dismiss"))} />
      </View>
    </Popover>
  );
}

export const BLOCKED_POPUPS_WIDTH = POPOVER_WIDTH.l;

export function BlockedPopupsPrompt({ tabId, right, left, top }: { tabId: string; right?: number; left?: number; top: number }) {
  const open = usePages((s) => s.popover[tabId] === "popups");
  const live = usePage(tabId, (p) => p.popups);
  const { shown: popups, closing, onClosed } = usePopoverPresenceOf(open && live.length ? live : null);
  const stillOpen = useStillOpen(open && live.length > 0);
  if (!popups) return null;
  const origin = popups[0]!.origin;
  const site = hostOrOrigin(origin);
  const web = () => webviews.get(tabId);
  const close = () => setPopover(tabId, null);
  const act = whileOpen(closing, () => stillOpen() && pageOf(tabId).popups.length > 0);
  const blocked = () => pageOf(tabId).popups;
  const done = () => {
    patchPage(tabId, { popups: [] });
    close();
  };
  const profile = () => currentEngineProfile(currentTab(tabId)?.profileId ?? "");
  return (
    <Popover width={BLOCKED_POPUPS_WIDTH} top={top} right={right} left={left} onDismiss={() => dismissPopoverByPress(tabId)} closing={closing} onClosed={onClosed}>
      <View style={{ paddingBottom: PANEL.listPadding }}>
        <PromptBody
          icons={["macwindow.badge.plus"]}
          title={`Always allow pop-ups from ${site}?`}
          message={`Allow ${site} to always open pop-up windows, choose every time, or always deny pop-ups.`}
        >
          <Button variant="pill"
            title="Always Deny"
            onPress={act(() => {
              void setSiteSetting(profile(), origin, "popups", "block");
              done();
            })}
          />
          <Button variant="pill"
            title="Only Once"
            onPress={act(() => {
              for (const p of blocked()) void web()?.openBlockedPopup(p.id, false);
              done();
            })}
          />
          <Button variant="pill"
            title="Always Allow"
            primary
            onPress={act(() => {
              for (const p of blocked()) void web()?.openBlockedPopup(p.id, true);
              done();
            })}
          />
        </PromptBody>
        <MenuSeparator />
        {popups.slice(-5).map((p) => (
          <MenuRow
            key={p.id}
            icon="arrow.up.forward.app"
            title={p.url.replace(/^https?:\/\//, "") || "about:blank"}
            onPress={act(() => {
              if (!blocked().some((x) => x.id === p.id)) return;
              void web()?.openBlockedPopup(p.id, false);
              const rest = blocked().filter((x) => x.id !== p.id);
              patchPage(tabId, { popups: rest });
              if (!rest.length) close();
            })}
          />
        ))}
        {popups.length > 5 ? (
          <Text size="caption" tone="textSecondary" style={{ paddingLeft: PANEL.textColumn, paddingTop: space.xxs }}>{`and ${popups.length - 5} more`}</Text>
        ) : null}
      </View>
    </Popover>
  );
}

export function PasswordPrompt({ tabId, right, top }: { tabId: string; right: number; top: number }) {
  const prompt = usePage(tabId, (p) => p.passwordPrompt);
  const [chosen, setChosen] = useState<string | null>(null);
  const guard = usePromptInputGuard(prompt ? `${prompt.origin}|${prompt.username}|${prompt.state}` : null);
  if (!prompt) return null;
  const site = hostOrOrigin(prompt.origin);
  const update = prompt.state === "update";
  const username = chosen ?? prompt.username;
  const answer = guard((action: PasswordPromptAnswer) => {
    answerPasswordPrompt(tabId, action, username, prompt);
    setChosen(null);
  });
  const choices = update && prompt.usernames.length > 1 ? prompt.usernames : [];
  return (
    <Popover key={`${prompt.origin}|${prompt.username}|${prompt.state}`} width={update ? POPOVER_WIDTH.s : POPOVER_WIDTH.m} top={top} right={right} modal={false}>
      <View>
        <PromptBody
          icons={["key.fill"]}
          title={update ? "Update saved password?" : `Save password for ${site}?`}
          message={update ? `It will be auto-filled on ${site}` : "That way, it'll be auto-filled next time"}
          detail={
            choices.length ? (
              <Well list>
                {choices.map((name) => (
                  <UsernameChoice key={name} name={name} selected={name === username} onPress={() => setChosen(name)} />
                ))}
              </Well>
            ) : (
              <Well gap="xs">
                <Text lines={1} size="small" weight="medium">
                  {username || (prompt.federation ? `Signed in with ${hostOrOrigin(prompt.federation)}` : "No username")}
                </Text>
                {prompt.passwordLength > 0 && (
                  <Text lines={1} size="small" tone="textSecondary" style={{ letterSpacing: tracking.wide }}>
                    {"•".repeat(Math.min(prompt.passwordLength, 16))}
                  </Text>
                )}
              </Well>
            )
          }
        >
          {!update && <Button variant="pill" title="Never on This Site" onPress={() => answer("never")} />}
          <Button variant="pill" title="Not Now" onPress={() => answer(update ? "nope" : "dismiss")} />
          <Button variant="pill" title={update ? "Update" : "Save"} primary onPress={() => answer(update ? "update" : "save")} />
        </PromptBody>
        <PanelCloseButton onPress={() => answer("dismiss")} />
      </View>
    </Popover>
  );
}

export function AutofillPrompt({ tabId, right, top }: { tabId: string; right: number; top: number }) {
  const prompt = usePage(tabId, (p) => p.autofillPrompt);
  const guard = usePromptInputGuard(prompt?.id);
  if (!prompt) return null;
  const shownId = prompt.id;
  const answer = guard((action: AutofillPromptAnswer) => void answerAutofillPrompt(tabId, action, shownId));
  const changes = prompt.changes ?? [];
  const values = (key: "to" | "from") => changes.filter((c) => c[key]).map((c) => c[key]);
  const section = (lines: string[], label?: string) => (
    <Box key={label ?? "lines"} gap="xs">
      {label ? (
        <Text size="caption" tone="textSecondary">
          {label}
        </Text>
      ) : null}
      {lines.map((line, i) => (
        <Text key={i} lines={2} size="small" weight={i === 0 && !label ? "medium" : "regular"} tone={i === 0 || label ? "textPrimary" : "textSecondary"}>
          {line}
        </Text>
      ))}
    </Box>
  );
  const sections =
    prompt.kind !== "updateAddress"
      ? [section(prompt.lines)]
      : prompt.newLabel
        ? [section(values("to"), prompt.newLabel), section(values("from"), prompt.oldLabel)]
        : [section(values("to"))];
  return (
    <Popover key={prompt.id} width={POPOVER_WIDTH.m} top={top} right={right} modal={false}>
      <View>
        <PromptBody
          icons={[prompt.kind === "saveCard" ? "creditcard.fill" : "mappin.and.ellipse"]}
          title={prompt.title}
          message={prompt.message || null}
          detail={
            <>
              <Well gap="m">{sections}</Well>
              {prompt.footer ? (
                <Text size="caption" tone="textSecondary">
                  {prompt.footer}
                </Text>
              ) : null}
            </>
          }
        >
          <Button variant="pill" title={prompt.decline} onPress={() => answer("decline")} />
          <Button variant="pill" title={prompt.accept} primary onPress={() => answer("accept")} />
        </PromptBody>
        <PanelCloseButton onPress={() => answer("dismiss")} />
      </View>
    </Popover>
  );
}

export function VerificationCodePrompt({ tabId, right, top }: { tabId: string; right: number; top: number }) {
  const offer = usePage(tabId, (p) => p.verificationCode);
  const guard = usePromptInputGuard(offer?.token);
  if (!offer) return null;
  const { title, message } = verificationCodeCopy(offer.app, offer.host);
  const close = guard(() => declineVerificationCode(tabId));
  return (
    <Popover key={offer.token} width={POPOVER_WIDTH.s} top={top} right={right} modal={false}>
      <View>
        <PromptBody icons={["key.fill"]} title={title} message={message}>
          <Button variant="pill" title="Not Now" onPress={close} />
          <Button variant="pill" title="Set Up" primary onPress={guard(() => acceptVerificationCode(tabId))} />
        </PromptBody>
        <PanelCloseButton onPress={close} />
      </View>
    </Popover>
  );
}

export function ExternalAppPrompt({ tabId, left, top }: { tabId: string; left: number; top: number }) {
  const request = usePage(tabId, (p) => p.externalApp);
  const [always, setAlways] = useState(false);
  const guard = usePromptInputGuard(request?.id);
  if (!request) return null;
  const answer = guard((open: boolean) => {
    answerExternalApp(tabId, open, open && always);
    setAlways(false);
  });
  return (
    <Popover key={request.id} width={EXTERNAL_APP_WIDTH} top={top} left={left} modal={false}>
      <View>
        <PromptBody
          icons={request.icon ? [] : ["app"]}
          image={request.icon}
          title={request.title}
          message={request.message}
          detail={
            request.remember ? <CheckRow value={always} onChange={guard(setAlways)} label={request.remember} /> : undefined
          }
        >
          <Button variant="pill" title="Cancel" onPress={() => answer(false)} />
          <Button variant="pill" title="Open" primary onPress={() => answer(true)} />
        </PromptBody>
        <PanelCloseButton onPress={() => answer(false)} />
      </View>
    </Popover>
  );
}

function UsernameChoice({ name, selected, onPress }: { name: string; selected: boolean; onPress: () => void }) {
  return <MenuRow checked={selected} title={name || "No username"} onPress={onPress} />;
}

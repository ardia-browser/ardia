import { consentToken, type ConsentToken } from "../telemetry/choice";
import { anyProfileOnArdia, onArdiaProfilesChanged, vaultsOnForTab } from "./enabled";
import { addVaultTotp, setVaultCodeSetup, type VaultCodeAction, type VaultCodeFound, type VaultItem } from "../../platform/vaults";
import { webviews } from "../../platform/webviews";
import { confirm } from "../app/system";
import { useBrowser } from "../browser/store";
import { rememberedVaultAccount } from "./accounts";
import { toastInTab, unlockForPick } from "./actions";
import { itemsForTab } from "./ardia";
import { forgetVaultCode } from "./codes";
import { itemKey } from "./originMatch";
import { noteVaultField, showAllPasswords, vaultMenuOf } from "./menu";
import { allVaultItems, currentVaultProviders, loadAllVaultItems, loadVaultItems, useVaults, vaultManagerName, vaultProviderOf } from "./store";
import { addedLine, addTotpErrorText, canHoldCode, CODE_TEXT, codeMenuModel, replaceQuestion } from "./totpSetupModel";
import { forgetCodePick, forgetPicksOutside, markCodePick } from "./menuPicks";
import { noteVaultCodeSetUp } from "../telemetry/vaultCounts";

type ConfirmOptions = Parameters<typeof confirm>[0];
type CodeAsk = (options: ConfirmOptions) => Promise<{ confirmed: boolean }>;

const codes = new Map<string, VaultCodeFound>();
const busy = new Set<string>();

const toast = (tabId: string, title: string, failed = false) => toastInTab(tabId, title, "vaultCode", failed);

const isCurrent = (tabId: string, code: VaultCodeFound) => codes.get(tabId) === code;
const itemOf = (key: string): VaultItem | undefined => allVaultItems().find((item) => itemKey(item) === key);

function sendMenu(tabId: string, code: VaultCodeFound) {
  const menu = codeMenuModel({
    origin: code.origin,
    account: code.account,
    providers: currentVaultProviders(),
    items: itemsForTab(allVaultItems(), tabId),
    remembered: rememberedVaultAccount(code.origin),
  });
  void webviews.get(tabId)?.setVaultCodeMenu({ token: code.token, menu })?.catch(() => undefined);
}

export function noteVaultCode(tabId: string, code: VaultCodeFound) {
  if (!vaultsOnForTab(tabId)) return;
  codes.set(tabId, code);
  forgetCodePick(tabId);
  sendMenu(tabId, code);
  void loadAllVaultItems().then(() => isCurrent(tabId, code) && sendMenu(tabId, code));
}

export const saveCodeTo = (tabId: string, code: VaultCodeFound, item: VaultItem, ask: CodeAsk = confirm) => runSaveCodeTo(tabId, code, item, ask, consentToken());

async function runSaveCodeTo(tabId: string, code: VaultCodeFound, item: VaultItem, ask: CodeAsk, consent: ConsentToken | null): Promise<void> {
  const name = vaultManagerName(item.provider);
  const provider = vaultProviderOf(item.provider);
  if (!provider || !canHoldCode(provider)) return toast(tabId, addTotpErrorText({ error: "unsupported" }, name), true);
  const key = `${tabId}:${code.token}`;
  if (busy.has(key)) return;
  busy.add(key);
  try {
    if (item.hasTotp === true) {
      const { confirmed } = await ask(replaceQuestion(item, name, code));
      if (!confirmed) return;
    }
    const result = await addVaultTotp(item.provider, item.id, code.token).catch(() => null);
    if (!result) return toast(tabId, CODE_TEXT.failed, true);
    if (result.error === "declined") return;
    if (!result.added) {
      if (result.error === "locked" || result.error === "notFound") void loadVaultItems(item.provider, true);
      return toast(tabId, addTotpErrorText(result, name), true);
    }
    if (isCurrent(tabId, code)) codes.delete(tabId);
    noteVaultCodeSetUp("contextMenu", 1, consent);
    forgetVaultCode(item);
    void loadVaultItems(item.provider, true);
    toast(tabId, addedLine(result.item ?? item));
  } finally {
    busy.delete(key);
  }
}

function openCodePicker(tabId: string, code: VaultCodeFound) {
  if (!code.rect) return toast(tabId, CODE_TEXT.noRect, true);
  noteVaultField(tabId, {
    frameId: code.frameId,
    origin: code.origin,
    main: code.main,
    kind: "username",
    focused: true,
    rect: code.rect,
    formHasPassword: false,
    clicked: true,
    maxLength: 0,
  });
  const menu = vaultMenuOf(tabId);
  if (!menu || menu.frameId !== code.frameId) return;
  markCodePick(tabId, menu.seq, (item) => void saveCodeTo(tabId, code, item));
  showAllPasswords(tabId);
}

async function unlockThenPick(tabId: string, code: VaultCodeFound) {
  const locked = currentVaultProviders().find((p) => p.state === "locked" && canHoldCode(p));
  if (!locked) return openCodePicker(tabId, code);
  if ((await unlockForPick(tabId, locked, "vaultCode")) && isCurrent(tabId, code)) openCodePicker(tabId, code);
}

export function runVaultCodeAction(tabId: string, action: VaultCodeAction) {
  const code = codes.get(tabId);
  if (!code || !vaultsOnForTab(tabId) || code.token !== action.token || code.frameId !== action.frameId || code.origin !== action.origin) return;
  switch (action.action) {
    case "save": {
      const item = itemOf(action.login);
      if (!item) return toast(tabId, CODE_TEXT.gone, true);
      return void saveCodeTo(tabId, code, item);
    }
    case "other":
      return openCodePicker(tabId, code);
    case "unlock":
      return void unlockThenPick(tabId, code);
  }
}

export const codeSetupWanted = (providers: ReturnType<typeof currentVaultProviders>) =>
  anyProfileOnArdia() && providers.some((p) => canHoldCode(p) && (p.state === "unlocked" || p.state === "locked"));

export function startVaultCodeSetup() {
  let sent: boolean | null = null;
  const push = () => {
    const wanted = codeSetupWanted(currentVaultProviders());
    if (wanted === sent) return;
    sent = wanted;
    void setVaultCodeSetup(wanted).catch(() => {
      sent = null;
    });
  };
  push();
  const stopVaults = useVaults.subscribe((s, prev) => s.providers !== prev.providers && push());
  const stopBrowser = useBrowser.subscribe((s, prev) => {
    if (s.tabs === prev.tabs) return;
    for (const tabId of codes.keys()) if (!s.tabs[tabId]) codes.delete(tabId);
    forgetPicksOutside(s.tabs);
  });
  const stopScope = onArdiaProfilesChanged(push);
  return () => {
    stopVaults();
    stopBrowser();
    stopScope();
  };
}

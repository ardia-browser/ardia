import { ipcMain, type WebContents } from "electron";
import { emit } from "../bridge";
import { guestById, guestOf, tell } from "../engine/guests";
import { addresses, cardNumber, cards, saveAddress, saveCard, settingsOf } from "./autofill";
import { FillGrants, frameAllows, isAutofillKind } from "./autofillFrames";
import { definePageScript, profileOfContents } from "./guests";
import { isPrivateProfile } from "./profiles";

const CHANNEL = "ardia:autofill";
const SUBMISSION_KEPT_MS = 60_000;
const NETWORK_NAMES: Record<string, string> = { visa: "Visa", mastercard: "Mastercard", amex: "American Express", discover: "Discover", diners: "Diners Club", jcb: "JCB", unionpay: "UnionPay", card: "Card" };

type AddressKey = "name" | "organization" | "street" | "city" | "state" | "postalCode" | "country" | "phone" | "email";
type AddressFields = Partial<Record<AddressKey, string>>;
type SubmittedCard = { name?: string; number?: string; expMonth?: number; expYear?: number };
type Submission = { profile: string; address: AddressFields | null; card: SubmittedCard | null; at: number };
type Change = { field: "name" | "address" | "email" | "phone" | "other"; from: string; to: string };
type Prompt = {
  id: number;
  kind: "saveAddress" | "updateAddress" | "saveCard";
  origin: string;
  title: string;
  message: string;
  accept: string;
  decline: string;
  footer: string;
  lines: string[];
  changes?: Change[];
  newLabel?: string;
  oldLabel?: string;
};
type Pending = { prompt: Prompt; save: () => void };

function autofillPage(ipc: Electron.IpcRenderer) {
  const CHANNEL = "ardia:autofill";
  type FieldType =
    | "name"
    | "givenName"
    | "familyName"
    | "organization"
    | "street"
    | "line1"
    | "line2"
    | "city"
    | "state"
    | "postalCode"
    | "country"
    | "phone"
    | "email"
    | "ccName"
    | "ccNumber"
    | "ccExp"
    | "ccExpMonth"
    | "ccExpYear"
    | "ccCsc";
  type Kind = "address" | "card";
  type Field = HTMLInputElement | HTMLSelectElement;
  type Suggestion = { id: string; main: string; sub: string };

  const AUTOCOMPLETE: Record<string, FieldType> = {
    name: "name",
    "given-name": "givenName",
    "family-name": "familyName",
    organization: "organization",
    "street-address": "street",
    "address-line1": "line1",
    "address-line2": "line2",
    "address-level2": "city",
    "address-level1": "state",
    "postal-code": "postalCode",
    country: "country",
    "country-name": "country",
    tel: "phone",
    "tel-national": "phone",
    email: "email",
    "cc-name": "ccName",
    "cc-number": "ccNumber",
    "cc-exp": "ccExp",
    "cc-exp-month": "ccExpMonth",
    "cc-exp-year": "ccExpYear",
    "cc-csc": "ccCsc",
  };
  const PATTERNS: [FieldType, RegExp][] = [
    ["ccCsc", /cvc|cvv|csc|security.?code|card.?verification/i],
    ["ccExpMonth", /(exp|expir)\w*.?(month|mm\b)|cc.?month|card.?month/i],
    ["ccExpYear", /(exp|expir)\w*.?(year|yy)|cc.?year|card.?year/i],
    ["ccExp", /expir|exp.?date|mm.?\/?.?yy/i],
    ["ccName", /(card|cc).?(holder|name)|name.?on.?card/i],
    ["ccNumber", /(card|cc).?(number|num|no\b)|cardnumber|ccnum|credit.?card/i],
    ["email", /e.?mail/i],
    ["phone", /phone|mobile|\btel\b|telephone/i],
    ["givenName", /first.?name|given.?name|\bfname\b|forename/i],
    ["familyName", /last.?name|surname|family.?name|\blname\b/i],
    ["organization", /company|organi[sz]ation|business.?name/i],
    ["line2", /address.?(line)?.?2|addr2|apartment|\bapt\b|suite/i],
    ["line1", /address.?(line)?.?1|addr1/i],
    ["postalCode", /zip|postal|post.?code/i],
    ["city", /city|town|locality|suburb/i],
    ["state", /\bstate\b|province|region|county/i],
    ["country", /country/i],
    ["street", /street|address/i],
    ["name", /full.?name|your.?name|^\s*name\s*$|\bname\b/i],
  ];
  const TEXT_TYPES = ["text", "email", "tel", "number", "search", ""];
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

  const shown = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const fillable = (el: Element): el is Field =>
    (el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && TEXT_TYPES.includes(el.type.toLowerCase()))) && !el.disabled && !(el as HTMLInputElement).readOnly;

  function typeOf(el: Field): FieldType | null {
    const tokens = (el.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    for (const token of tokens.reverse()) if (AUTOCOMPLETE[token]) return AUTOCOMPLETE[token]!;
    const label = el.labels?.[0]?.textContent ?? "";
    const text = [el.name, el.id, el.getAttribute("placeholder") ?? "", el.getAttribute("aria-label") ?? "", label].join(" ").replace(/([a-z])([A-Z])/g, "$1 $2");
    if (!text.trim() || /user.?name|login|password|search|captcha|coupon|promo/i.test(text)) return null;
    for (const [type, pattern] of PATTERNS) if (pattern.test(text)) return type;
    if (el instanceof HTMLInputElement && el.type === "email") return "email";
    if (el instanceof HTMLInputElement && el.type === "tel") return "phone";
    return null;
  }
  const kindOf = (type: FieldType): Kind => (type.startsWith("cc") ? "card" : "address");

  function fieldsNear(el: Field): [Field, FieldType][] {
    const scope: ParentNode = el.form ?? document;
    const out: [Field, FieldType][] = [];
    for (const candidate of Array.from(scope.querySelectorAll("input, select"))) {
      if (!fillable(candidate) || !shown(candidate)) continue;
      const type = typeOf(candidate);
      if (type) out.push([candidate, type]);
    }
    return out;
  }

  const highlighted = new WeakMap<Field, string>();
  function setValue(el: Field, value: string) {
    if (el instanceof HTMLSelectElement) {
      el.value = value;
    } else {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (!highlighted.has(el)) highlighted.set(el, el.style.backgroundColor);
    el.style.backgroundColor = "rgba(232, 240, 254, 1)";
  }
  document.addEventListener(
    "input",
    (event) => {
      const el = event.target as Field;
      if (!event.isTrusted || !highlighted.has(el)) return;
      el.style.backgroundColor = highlighted.get(el)!;
      highlighted.delete(el);
    },
    true,
  );

  function optionFor(select: HTMLSelectElement, wanted: string[]): string | null {
    const options = Array.from(select.options);
    const norm = (s: string) => s.trim().toLowerCase();
    for (const want of wanted.map(norm).filter(Boolean)) {
      const found = options.find((o) => norm(o.value) === want || norm(o.text) === want) ?? options.find((o) => norm(o.text).startsWith(want) && want.length >= 3);
      if (found) return found.value;
    }
    return null;
  }

  function valueFor(el: Field, type: FieldType, values: Record<string, string>): string | null {
    const month = values.ccExpMonth ?? "";
    const year = values.ccExpYear ?? "";
    if (type === "ccExp") {
      if (!month || !year) return null;
      const hint = `${el.getAttribute("placeholder") ?? ""} ${el.getAttribute("aria-label") ?? ""}`.toLowerCase();
      const long = hint.includes("yyyy") || (el instanceof HTMLInputElement && el.maxLength >= 7 && !hint.includes("yy"));
      return `${month}/${long ? year : year.slice(-2)}`;
    }
    if (el instanceof HTMLSelectElement) {
      const value = values[type] ?? "";
      if (!value) return null;
      if (type === "ccExpMonth") return optionFor(el, [month, String(Number(month)), MONTHS[Number(month) - 1] ?? ""]);
      if (type === "ccExpYear") return optionFor(el, [year, year.slice(-2)]);
      return optionFor(el, [value]);
    }
    if (type === "ccExpYear") {
      const short = el.maxLength === 2 || /^yy$/i.test(el.getAttribute("placeholder") ?? "");
      return short ? year.slice(-2) : year;
    }
    return values[type] ?? null;
  }

  let host: HTMLElement | null = null;
  let root: ShadowRoot | null = null;
  let open: { field: Field; type: FieldType; kind: Kind; list: Suggestion[]; selected: number } | null = null;
  let asked = 0;

  function ensurePopup(): ShadowRoot {
    if (root && host?.isConnected) return root;
    host = document.createElement("ardia-autofill");
    host.style.cssText = "all: initial; position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 2147483647;";
    root = host.attachShadow({ mode: "closed" });
    document.documentElement.appendChild(host);
    return root;
  }

  function hide() {
    open = null;
    if (root) root.innerHTML = "";
  }

  const STYLE = `
    .popup { position: fixed; box-sizing: border-box; min-width: 240px; max-width: 380px; padding: 6px; border-radius: 10px;
      background: #fff; color: #1d1d1f; box-shadow: 0 0 0 0.5px rgba(0,0,0,.12), 0 10px 30px rgba(0,0,0,.18);
      font: 13px/1.3 system-ui, -apple-system, "Segoe UI", Ubuntu, Cantarell, sans-serif; user-select: none; }
    .row { display: flex; flex-direction: column; gap: 1px; padding: 6px 10px; border-radius: 6px; cursor: default; }
    .row.selected { background: rgba(0, 0, 0, .06); }
    .main { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sub { color: #6e6e73; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rule { height: 1px; margin: 5px 4px; background: rgba(0,0,0,.08); }
    .manage { padding: 6px 10px; border-radius: 6px; color: #3c3c43; }
    .manage.selected { background: rgba(0, 0, 0, .06); }
    @media (prefers-color-scheme: dark) {
      .popup { background: #2c2c2e; color: #f2f2f7; box-shadow: 0 0 0 0.5px rgba(255,255,255,.14), 0 10px 30px rgba(0,0,0,.5); }
      .row.selected, .manage.selected { background: rgba(255, 255, 255, .1); }
      .sub { color: #a1a1a6; } .manage { color: #d1d1d6; } .rule { background: rgba(255,255,255,.1); }
    }`;

  function render() {
    const shadow = ensurePopup();
    if (!open) return hide();
    const rect = open.field.getBoundingClientRect();
    const rows = open.list
      .map((s, i) => `<div class="row${i === open!.selected ? " selected" : ""}" data-index="${i}"><div class="main"></div>${s.sub ? '<div class="sub"></div>' : ""}</div>`)
      .join("");
    const manageIndex = open.list.length;
    shadow.innerHTML = `<style>${STYLE}</style><div class="popup" role="listbox">${rows}<div class="rule"></div><div class="manage${open.selected === manageIndex ? " selected" : ""}" data-index="${manageIndex}">${open.kind === "card" ? "Manage payment methods…" : "Manage addresses…"}</div></div>`;
    const popup = shadow.querySelector<HTMLElement>(".popup")!;
    shadow.querySelectorAll<HTMLElement>(".row").forEach((row, i) => {
      row.querySelector(".main")!.textContent = open!.list[i]!.main;
      const sub = row.querySelector(".sub");
      if (sub) sub.textContent = open!.list[i]!.sub;
    });
    popup.style.minWidth = `${Math.max(240, rect.width)}px`;
    const height = popup.offsetHeight;
    const below = rect.bottom + 4 + height <= innerHeight || rect.top - 4 - height < 0;
    popup.style.left = `${Math.max(4, Math.min(rect.left, innerWidth - popup.offsetWidth - 4))}px`;
    popup.style.top = `${below ? rect.bottom + 4 : rect.top - 4 - height}px`;
    popup.addEventListener("mousedown", (event) => event.preventDefault());
    popup.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      const target = (event.target as Element).closest<HTMLElement>("[data-index]");
      if (target) void choose(Number(target.dataset.index));
    });
  }

  async function suggest(field: Field, force: boolean) {
    const type = typeOf(field);
    if (!type || type === "ccCsc" || !shown(field)) return hide();
    const kind = kindOf(type);
    if (kind === "card" && !isSecureContext) return hide();
    const typed = field instanceof HTMLInputElement ? field.value : "";
    if (!force && typed && open?.field !== field) return;
    const ask = ++asked;
    const list: Suggestion[] = await ipc.invoke(`${CHANNEL}:suggest`, { kind, type, typed }).catch(() => []);
    if (ask !== asked || document.activeElement !== field) return;
    if (!Array.isArray(list) || !list.length) return hide();
    open = { field, type, kind, list, selected: -1 };
    render();
  }

  async function choose(index: number) {
    if (!open) return;
    const { field, kind, list } = open;
    hide();
    if (index >= list.length) return ipc.send(`${CHANNEL}:manage`, kind);
    const suggestion = list[index];
    if (!suggestion) return;
    const values: Record<string, string> | null = await ipc.invoke(`${CHANNEL}:fill`, { kind, id: suggestion.id }).catch(() => null);
    if (!values) return;
    for (const [el, type] of fieldsNear(field)) {
      if (kindOf(type) !== kind || type === "ccCsc") continue;
      if (el !== field && el instanceof HTMLInputElement && el.value) continue;
      const value = valueFor(el, type, values);
      if (value) setValue(el, value);
    }
  }

  document.addEventListener(
    "mousedown",
    (event) => {
      if (!event.isTrusted) return;
      const el = event.target;
      if (el instanceof Element && host?.contains(el)) return;
      if (el instanceof HTMLInputElement && fillable(el)) setTimeout(() => void suggest(el, true), 0);
      else hide();
    },
    true,
  );
  document.addEventListener(
    "input",
    (event) => {
      const el = event.target;
      if (event.isTrusted && el instanceof HTMLInputElement && fillable(el) && el === document.activeElement) void suggest(el, true);
    },
    true,
  );
  document.addEventListener("focusout", () => setTimeout(() => open && document.activeElement !== open.field && hide(), 0), true);
  addEventListener("scroll", () => open && render(), true);
  addEventListener("resize", () => open && render());

  let submittedAt = 0;
  function capture(origin: Element | null) {
    const anchor = origin instanceof HTMLFormElement ? origin : origin instanceof Element ? (origin.closest("form") ?? null) : null;
    const scope: ParentNode = anchor ?? document;
    const now = Date.now();
    if (now - submittedAt < 300) return;
    const values: Partial<Record<FieldType, string>> = {};
    for (const el of Array.from(scope.querySelectorAll("input, select"))) {
      if (!fillable(el) || !shown(el)) continue;
      const type = typeOf(el);
      if (!type || type === "ccCsc" || values[type]) continue;
      const value = el instanceof HTMLSelectElement ? (type === "country" || type === "state" ? (el.selectedOptions[0]?.text ?? "") : el.value) : el.value;
      if (value.trim()) values[type] = value.trim();
    }
    const name = values.name ?? [values.givenName, values.familyName].filter(Boolean).join(" ");
    const street = values.street ?? [values.line1, values.line2].filter(Boolean).join("\n");
    const address = { name, organization: values.organization, street, city: values.city, state: values.state, postalCode: values.postalCode, country: values.country, phone: values.phone, email: values.email };
    let expMonth = Number(values.ccExpMonth) || MONTHS.indexOf((values.ccExpMonth ?? "").slice(0, 3).toLowerCase()) + 1 || undefined;
    let expYear = Number(values.ccExpYear) || undefined;
    const combined = values.ccExp?.match(/^\s*(\d{1,2})\s*[\/\-. ]\s*(\d{2}|\d{4})\s*$/);
    if (combined) {
      expMonth = Number(combined[1]);
      expYear = Number(combined[2]);
    }
    if (expYear && expYear < 100) expYear += 2000;
    const card = values.ccNumber && isSecureContext ? { name: values.ccName, number: values.ccNumber, expMonth, expYear } : null;
    const hasAddress = !!street && !!(address.city || address.postalCode);
    if (!card && !hasAddress) return;
    submittedAt = now;
    ipc.send(`${CHANNEL}:submitted`, { address: hasAddress ? address : null, card });
    setTimeout(() => {
      const still = anchor ? anchor.isConnected && shown(anchor) : false;
      if (!still) ipc.send(`${CHANNEL}:gone`);
    }, 1500);
  }

  document.addEventListener("submit", (event) => capture(event.target as Element), true);
  document.addEventListener(
    "keydown",
    (event) => {
      if (!event.isTrusted) return;
      const el = event.target;
      if (open && el === open.field) {
        const count = open.list.length + 1;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          open.selected = (open.selected + (event.key === "ArrowDown" ? 1 : count - 1) + (open.selected < 0 && event.key === "ArrowUp" ? 1 : 0)) % count;
          render();
          event.preventDefault();
          return;
        }
        if (event.key === "Enter" && open.selected >= 0) {
          event.preventDefault();
          event.stopPropagation();
          void choose(open.selected);
          return;
        }
        if (event.key === "Escape") {
          hide();
          event.preventDefault();
          return;
        }
      }
      if (event.key === "ArrowDown" && el instanceof HTMLInputElement && fillable(el) && !open) {
        void suggest(el, true);
        return;
      }
      if (event.key === "Enter" && el instanceof HTMLInputElement && el.form) capture(el);
    },
    true,
  );
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof Element ? event.target.closest('button, input[type="submit"], [role="button"]') : null;
      if (target && !(target instanceof HTMLButtonElement && target.type === "button" && !target.form)) capture(target);
    },
    true,
  );
}

definePageScript("ardia-autofill", autofillPage);

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const firstLine = (street: string | undefined) => (street ?? "").split("\n")[0]!.trim();
const norm = (value: string | undefined) => (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const two = (n: number) => String(n).padStart(2, "0");

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  return sum % 10 === 0;
}

function splitName(name: string | undefined) {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return { givenName: parts.length > 1 ? parts.slice(0, -1).join(" ") : (parts[0] ?? ""), familyName: parts.length > 1 ? parts.at(-1)! : "" };
}

function addressValues(address: AddressFields): Record<string, string> {
  const lines = (address.street ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  const out: Record<string, string> = { ...splitName(address.name), line1: lines[0] ?? "", line2: lines.slice(1).join(", ") };
  for (const [key, value] of Object.entries(address)) if (typeof value === "string") out[key] = key === "street" ? lines.join(", ") : value;
  return out;
}

function addressSummary(address: AddressFields): string[] {
  const cityLine = [address.city, [address.state, address.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [address.name, address.organization, ...(address.street ?? "").split("\n"), cityLine, address.country, address.email, address.phone].map((line) => (line ?? "").trim()).filter(Boolean);
}

const cardTitle = (network: string, last4: string) => `${NETWORK_NAMES[network] ?? "Card"} ••••${last4}`;
const expiry = (month?: number, year?: number) => (month && year ? `${two(month)}/${two(year % 100)}` : "");

function suggestions(profile: string, kind: string, type: string, typed: string) {
  const settings = settingsOf(profile);
  const prefix = typed.trim().toLowerCase();
  if (kind === "card") {
    if (!settings.cards) return [];
    return cards(profile)
      .map((card) => {
        const main = type === "ccName" && card.name ? card.name : cardTitle(card.network, card.last4);
        const sub = [type === "ccName" ? cardTitle(card.network, card.last4) : card.name, expiry(card.expMonth, card.expYear) && `Expires ${expiry(card.expMonth, card.expYear)}`].filter(Boolean).join(" · ");
        return { id: card.id, main, sub, match: type === "ccName" ? (card.name ?? "") : card.last4 };
      })
      .filter((s) => !prefix || s.match.toLowerCase().startsWith(prefix) || type !== "ccName")
      .map(({ id, main, sub }) => ({ id, main, sub }));
  }
  if (!settings.addresses) return [];
  return addresses(profile)
    .map((address) => {
      const values = addressValues(address);
      const main = values[type] ?? "";
      const naming = type === "name" || type === "givenName" || type === "familyName";
      const summary = [naming ? "" : address.name, firstLine(address.street), address.city].filter((part) => part && part !== main);
      return { id: address.id, main, sub: summary.slice(0, 2).join(", ") };
    })
    .filter((s) => s.main && (!prefix || s.main.toLowerCase().startsWith(prefix)));
}

function fillValues(profile: string, kind: string, id: string): Record<string, string> | null {
  if (kind === "card") {
    if (!settingsOf(profile).cards) return null;
    const card = cards(profile).find((c) => c.id === id);
    const number = card ? cardNumber(profile, id) : null;
    if (!card || !number) return null;
    return { ccName: card.name ?? "", ccNumber: number, ccExpMonth: card.expMonth ? two(card.expMonth) : "", ccExpYear: card.expYear ? String(card.expYear) : "" };
  }
  if (!settingsOf(profile).addresses) return null;
  const address = addresses(profile).find((a) => a.id === id);
  return address ? addressValues(address) : null;
}

const submissions = new Map<number, Submission>();
const queues = new Map<number, Pending[]>();
const watched = new WeakSet<WebContents>();
const grants = new FillGrants();
const grantsWatched = new WeakSet<WebContents>();
let nextPromptId = 1;

function cleanAddress(input: unknown): AddressFields | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const keys: AddressKey[] = ["name", "organization", "street", "city", "state", "postalCode", "country", "phone", "email"];
  const out: AddressFields = {};
  for (const key of keys) if (text(raw[key])) out[key] = text(raw[key]).slice(0, 500);
  return out.street && (out.city || out.postalCode) ? out : null;
}

function cleanCard(input: unknown): SubmittedCard | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const number = text(raw.number).replace(/[\s-]/g, "");
  if (!/^\d{12,19}$/.test(number) || !luhn(number)) return null;
  const month = Number(raw.expMonth);
  const year = Number(raw.expYear);
  return {
    number,
    ...(text(raw.name) ? { name: text(raw.name).slice(0, 200) } : {}),
    ...(month >= 1 && month <= 12 ? { expMonth: month } : {}),
    ...(year >= 2000 && year <= 2100 ? { expYear: year } : {}),
  };
}

const CHANGE_FIELDS: { key: AddressKey; field: Change["field"] }[] = [
  { key: "name", field: "name" },
  { key: "organization", field: "other" },
  { key: "street", field: "address" },
  { key: "city", field: "address" },
  { key: "state", field: "address" },
  { key: "postalCode", field: "address" },
  { key: "country", field: "address" },
  { key: "email", field: "email" },
  { key: "phone", field: "phone" },
];

function addressPrompt(profile: string, origin: string, address: AddressFields): Pending | null {
  const saved = addresses(profile);
  const same = saved.find((existing) => norm(firstLine(existing.street)) === norm(firstLine(address.street)) && (!existing.name || !address.name || norm(existing.name) === norm(address.name)));
  if (!same) {
    return {
      prompt: { id: nextPromptId++, kind: "saveAddress", origin, title: "Save address?", message: "", accept: "Save", decline: "No thanks", footer: "", lines: addressSummary(address) },
      save: () => void saveAddress(profile, address),
    };
  }
  const changes: Change[] = [];
  const merged: AddressFields = { ...same };
  for (const { key, field } of CHANGE_FIELDS) {
    const to = address[key];
    const from = (same as AddressFields)[key] ?? "";
    if (!to || norm(to) === norm(from)) continue;
    changes.push({ field, from, to });
    merged[key] = to;
  }
  if (!changes.length) return null;
  const addsOnly = changes.every((change) => !change.from);
  return {
    prompt: {
      id: nextPromptId++,
      kind: "updateAddress",
      origin,
      title: addsOnly ? "Add new info to saved address?" : "Update address?",
      message: [same.name, firstLine(same.street)].filter(Boolean).join(", "),
      accept: addsOnly ? "Save" : "Update",
      decline: "No thanks",
      footer: "",
      lines: [],
      changes,
      newLabel: addsOnly ? "" : "New",
      oldLabel: addsOnly ? "" : "Old",
    },
    save: () => void saveAddress(profile, { ...merged, id: same.id }),
  };
}

function cardPrompt(profile: string, origin: string, card: SubmittedCard): Pending | null {
  const number = card.number!;
  const known = cards(profile).some((saved) => saved.last4 === number.slice(-4) && cardNumber(profile, saved.id) === number);
  if (known) return null;
  const network = cardNetworkOf(number);
  const exp = expiry(card.expMonth, card.expYear);
  return {
    prompt: {
      id: nextPromptId++,
      kind: "saveCard",
      origin,
      title: "Save card?",
      message: "To pay faster next time, save your card to your device",
      accept: "Save",
      decline: "No thanks",
      footer: "",
      lines: [`${NETWORK_NAMES[network] ?? "Card"} ••${number.slice(-4)}${exp ? ` • ${exp}` : ""}`],
    },
    save: () => void saveCard(profile, { name: card.name, expMonth: card.expMonth, expYear: card.expYear }, number),
  };
}

function cardNetworkOf(number: string): string {
  if (/^4/.test(number)) return "visa";
  if (/^3[47]/.test(number)) return "amex";
  const four = Number(number.slice(0, 4));
  if (/^5[1-5]/.test(number) || (four >= 2221 && four <= 2720)) return "mastercard";
  if (/^(6011|65)/.test(number) || (Number(number.slice(0, 3)) >= 644 && Number(number.slice(0, 3)) <= 649)) return "discover";
  if (/^(36|38|30[0-5])/.test(number)) return "diners";
  if (/^35/.test(number)) return "jcb";
  if (/^62/.test(number)) return "unionpay";
  return "card";
}

function showNext(contents: WebContents) {
  const queue = queues.get(contents.id);
  const next = queue?.[0];
  const guest = guestOf(contents);
  if (!next || !guest) return;
  tell(guest, "autofillPrompt", next.prompt);
}

function offer(contents: WebContents) {
  const submission = submissions.get(contents.id);
  submissions.delete(contents.id);
  if (!submission || Date.now() - submission.at > SUBMISSION_KEPT_MS || isPrivateProfile(submission.profile)) return;
  let origin = "";
  try {
    origin = new URL(contents.getURL()).origin;
  } catch {}
  const settings = settingsOf(submission.profile);
  const pending: Pending[] = [];
  try {
    if (submission.card && settings.cards) {
      const card = cardPrompt(submission.profile, origin, submission.card);
      if (card) pending.push(card);
    }
    if (submission.address && settings.addresses) {
      const address = addressPrompt(submission.profile, origin, submission.address);
      if (address) pending.push(address);
    }
  } catch {
    return;
  }
  if (!pending.length) return;
  const showing = (queues.get(contents.id) ?? []).length > 0;
  queues.set(contents.id, [...(queues.get(contents.id) ?? []), ...pending]);
  if (!showing) showNext(contents);
}

function watch(contents: WebContents) {
  if (watched.has(contents)) return;
  watched.add(contents);
  contents.on("did-navigate", () => offer(contents));
  contents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
    if (isMainFrame) offer(contents);
  });
  contents.once("destroyed", () => {
    submissions.delete(contents.id);
    queues.delete(contents.id);
  });
}

function watchGrants(contents: WebContents) {
  if (grantsWatched.has(contents)) return;
  grantsWatched.add(contents);
  contents.on("did-frame-navigate", (_event, _url, _code, _status, _isMainFrame, processId, routingId) => grants.forgetFrame(contents.id, processId, routingId));
  contents.once("destroyed", () => grants.forgetContents(contents.id));
}

export function resolveAutofillPrompt(webContentsId: number, id: number, answer: string): void {
  const queue = queues.get(webContentsId);
  const at = queue?.findIndex((pending) => pending.prompt.id === id) ?? -1;
  if (!queue || at < 0) return;
  const [pending] = queue.splice(at, 1);
  if (answer === "accept") {
    try {
      pending!.save();
    } catch {}
  }
  const contents = guestById(webContentsId)?.contents;
  if (contents && !contents.isDestroyed()) showNext(contents);
}

ipcMain.handle(`${CHANNEL}:suggest`, (event, request: { kind?: unknown; type?: unknown; typed?: unknown }) => {
  const profile = profileOfContents(event.sender);
  const kind = request?.kind;
  const frame = event.senderFrame;
  if (profile === null || !isAutofillKind(kind) || !frame || !frameAllows(frame, kind)) return [];
  try {
    const list = suggestions(profile, kind, text(request?.type), typeof request?.typed === "string" ? request.typed : "").slice(0, 8);
    watchGrants(event.sender);
    grants.offer(event.sender.id, frame, kind, list.map((suggestion) => suggestion.id));
    return list;
  } catch {
    return [];
  }
});

ipcMain.handle(`${CHANNEL}:fill`, (event, request: { kind?: unknown; id?: unknown }) => {
  const profile = profileOfContents(event.sender);
  const kind = request?.kind;
  const id = text(request?.id);
  if (profile === null || !isAutofillKind(kind) || !grants.take(event.sender.id, event.senderFrame, kind, id)) return null;
  try {
    return fillValues(profile, kind, id);
  } catch {
    return null;
  }
});

ipcMain.on(`${CHANNEL}:manage`, (event) => {
  const guest = guestOf(event.sender);
  emit("ArdiaMenus", "onCommand", { command: "autofill", arg: null, windowId: guest?.windowId || null, focusGeneration: null });
});

ipcMain.on(`${CHANNEL}:submitted`, (event, submitted: { address?: unknown; card?: unknown }) => {
  const profile = profileOfContents(event.sender);
  if (profile === null || isPrivateProfile(profile)) return;
  const address = cleanAddress(submitted?.address);
  const card = cleanCard(submitted?.card);
  if (!address && !card) return;
  watch(event.sender);
  submissions.set(event.sender.id, { profile, address, card, at: Date.now() });
});

ipcMain.on(`${CHANNEL}:gone`, (event) => offer(event.sender));

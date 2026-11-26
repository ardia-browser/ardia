import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, reporter, sleep } from "../../../scripts/lib/instance.mjs";

const args = process.argv.slice(2);
const appArg = args.find((a) => !a.startsWith("--"));
if (!appArg) {
  console.error(`usage: node me-card-test.mjs <Debug Ardia.app> [--metro-port=<n>] [--keep-data] [--only=<regex>]

Spec tests E28-E30 (docs/apple-passwords-spec.md): a hidden instance whose Me card reader reads a fixture card
(ARDIA_TEST meCard=<file>, Debug builds only) instead of Contacts. Turns "Use my Me card from Contacts" on, checks
the saved addresses against the fixture's literals, fills a fixture form in a Chromium tab and a WebKit tab,
rewrites the fixture and checks the entries follow, then turns the switch off and checks they are gone.
One PASS/FAIL line per check; the detail goes to <scratch>/me-card-test.log.`);
  process.exit(2);
}
const appPath = resolve(appArg);
const keep = args.includes("--keep-data");
const metroPort = Number(args.find((a) => a.startsWith("--metro-port="))?.slice(13) ?? process.env.METRO_PORT ?? 8081);
const onlyArg = args.find((a) => a.startsWith("--only="))?.slice(7);
const only = onlyArg ? new RegExp(onlyArg) : null;
const scratch = mkdtempSync(join(tmpdir(), "ac-me-card-"));
const data = join(scratch, "data");
const fixture = join(scratch, "me-card.json");
const rep = reporter(join(scratch, "me-card-test.log"), { name: "me-card-test" });

const ADA = { name: "Ada Lovelace", organization: "Analytical Engines", emails: ["ada@example.com", "ada.work@example.com"], phones: ["+1 415 555 0134", "+1 415 555 0177"] };
const HOME = { street: "1 Infinite Loop", city: "Cupertino", state: "CA", postalCode: "95014", country: "US" };
const WORK = { street: "500 Terry Francine St", city: "San Francisco", state: "CA", postalCode: "94158", country: "US" };
const TWO_ADDRESSES = { ...ADA, addresses: [HOME, WORK] };
const NO_ADDRESS = { ...ADA, addresses: [] };
const CHANGED = { ...ADA, phones: ["+1 415 555 0199"], addresses: [HOME] };
const writeCard = (card) => writeFileSync(fixture, JSON.stringify(card));

const FIELDS = [
  ["name", "name", "text"],
  ["organization", "organization", "text"],
  ["email", "email", "email"],
  ["tel", "tel", "tel"],
  ["street", "street-address", "text"],
  ["city", "address-level2", "text"],
  ["state", "address-level1", "text"],
  ["zip", "postal-code", "text"],
  ["country", "country", "text"],
];
const FORM = `<!doctype html><title>Sign up</title><link rel="icon" href="data:,"><body style="font:16px sans-serif;margin:24px"><form action="/done">${FIELDS.map(
  ([id, autocomplete, type]) => `<label style="display:block;margin:6px 0">${id} <input id="${id}" name="${id}" type="${type}" autocomplete="${autocomplete}" style="width:320px;height:28px"></label>`,
).join("")}<button>Sign up</button></form>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(req.url.startsWith("/form") ? FORM : "<!doctype html><title>Done</title>done");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const chromiumForm = `http://127.0.0.1:${port}/form`;
const webkitOrigin = `http://localhost:${port}`;
const webkitForm = `${webkitOrigin}/form`;

const q = JSON.stringify;
const digits = (s) => String(s ?? "").replace(/\D/g, "");
let app = null;

async function until(what, test, ms = 10000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await test();
    if (last) return last;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}${last === undefined ? "" : `; last ${q(last)}`}`);
}

const engine = (verb, a) => app.eval(`return ac.engine.call(${q(verb)}, ${q(a)})`);
const PROFILE = "";
const addresses = async () => (await engine("autofill.addresses", { profile: PROFILE })).addresses ?? [];
const fromContactsIds = () => app.eval(`return ac.meCard.useMeCard.getState().entries[${q(PROFILE)}] ?? null`);
const switchMeCard = (on) => app.eval(`return ac.meCard.setMeCardFor(${q(PROFILE)}, ${on}).then(() => ({ on: !!ac.meCard.useMeCard.getState().entries[${q(PROFILE)}], hint: ac.meCard.useMeCard.getState().hints[${q(PROFILE)}] ?? null }))`, { timeout: 20000 });

async function contactEntries() {
  const ids = (await fromContactsIds()) ?? [];
  const all = await addresses();
  return ids.map((id) => all.find((a) => a.id === id) ?? { id, missing: true });
}

const expectedEntry = (card, address) => ({
  name: card.name,
  organization: card.organization,
  email: card.emails[0],
  phone: digits(card.phones[0]),
  street: address?.street ?? "",
  city: address?.city ?? "",
  state: address?.state ?? "",
  postalCode: address?.postalCode ?? "",
  country: address?.country ?? "",
});
const shapeOf = (a) => ({
  name: a.name ?? "",
  organization: a.organization ?? "",
  email: a.email ?? "",
  phone: digits(a.phone),
  street: a.street ?? "",
  city: a.city ?? "",
  state: a.state ?? "",
  postalCode: a.postalCode ?? "",
  country: a.country ?? "",
});
const sameEntries = (got, want) => {
  const key = (e) => JSON.stringify(e);
  return got.length === want.length && got.map(key).sort().join("\n") === want.map(key).sort().join("\n");
};

async function check(name, fn) {
  if (only && !only.test(name)) return rep.record(name, { skip: "--only" });
  await rep.check(name, fn);
}

const windowId = () => app.eval(`return ac.store.getState().windowOrder[0]`);

async function openTab(url) {
  const w = await windowId();
  const id = await app.eval(`return ac.store.getState().newTab(${q(w)}, { url: ${q(url)} })`);
  await until(`${url} loaded`, () => app.eval(`const t = ac.store.getState().tabs[${q(id)}]; return t?.title === "Sign up" && !ac.tabLive.liveOf(${q(id)})?.isLoading ? true : null`), 20000);
  await sleep(600);
  return id;
}
const closeTab = (id) => app.eval(`ac.store.getState().closeTab(${q(id)}); return true`).catch(() => null);

const fieldValues = `Object.fromEntries(${q(FIELDS.map(([id]) => id))}.map((id) => [id, document.getElementById(id).value]))`;

function filledLike(values, card) {
  const address = [HOME, WORK].find((a) => a.street === values.street);
  if (!address) return `street ${q(values.street)} is neither fixture address`;
  const want = {
    name: card.name,
    organization: card.organization,
    email: card.emails[0],
    city: address.city,
    state: address.state,
    zip: address.postalCode,
  };
  for (const [k, v] of Object.entries(want)) if (values[k] !== v) return `${k} is ${q(values[k])}, wanted ${q(v)}`;
  if (!digits(values.tel).endsWith(digits(card.phones[0]).slice(-10))) return `tel is ${q(values.tel)}, wanted ${card.phones[0]}`;
  if (!["US", "United States"].includes(values.country)) return `country is ${q(values.country)}`;
  return null;
}

async function fillInChromium() {
  const id = await openTab(chromiumForm);
  try {
    const page = await app.page(chromiumForm, { timeout: 10000 });
    try {
      const value = async () => JSON.parse(await page.eval(`JSON.stringify(${fieldValues})`));
      const key = async (k) => {
        const code = { ArrowDown: 40, Enter: 13 }[k];
        const at = { key: k, code: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
        await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...at, ...(k === "Enter" ? { text: "\r" } : {}) });
        if (k === "Enter") await page.send("Input.dispatchKeyEvent", { type: "char", ...at, text: "\r" });
        await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...at });
      };
      const box = JSON.parse(await page.eval(`JSON.stringify(document.getElementById("name").getBoundingClientRect())`));
      const at = { x: box.x + 20, y: box.y + box.height / 2, button: "left", clickCount: 1 };
      let values = null;
      for (let attempt = 0; attempt < 3 && !values?.street; attempt++) {
        await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, buttons: 1 });
        await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, buttons: 0 });
        await sleep(900);
        await key("ArrowDown");
        await sleep(300);
        await key("Enter");
        values = await until("the Chromium form filled", async () => ((await value()).street ? value() : null), 4000).catch(() => null);
      }
      values ??= await value();
      return values;
    } finally {
      page.close();
    }
  } finally {
    await closeTab(id);
  }
}

async function fillInWebKit() {
  await app.eval(`const s = ac.store.getState(); s.updateSettings({ websiteEngines: { ...s.settings.websiteEngines, ${q(webkitOrigin)}: "webkit" } }); return true`);
  const id = await openTab(webkitForm);
  try {
    if (await engine("tabs.devBrowserId", { tabId: id }).catch(() => null)) throw new Error("the WebKit form opened in Chromium");
    const pageValue = (expr) => app.eval(`return ac.webviews.get(${q(id)})?.evaluate(${q(`post("result", JSON.stringify(${expr}))`)}) ?? null`);
    const read = async () => {
      const raw = await pageValue(fieldValues);
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    };
    const w = await windowId();
    const press = (key, keyCode) => app.eval(`return ac.shell.devKeyEquivalent(${q(w)}, { key: ${q(key)}, keyCode: ${keyCode}, modifiers: [], send: true, asKey: true, wait: 30 })`);
    const rectRaw = await pageValue(`document.getElementById("name").getBoundingClientRect()`);
    const rect = typeof rectRaw === "string" ? JSON.parse(rectRaw) : rectRaw;
    let values = null;
    for (let attempt = 0; attempt < 3 && !values?.street; attempt++) {
      const click = await app.eval(`return ac.shell.devClick(${q(w)}, { in: "page", x: ${Math.round(rect.x + 20)}, y: ${Math.round(rect.y + rect.height / 2)}, wait: 150 })`);
      rep.log("webkit click", click);
      await sleep(900);
      rep.log("down", await press("\uF701", 125));
      await sleep(300);
      rep.log("enter", await press("\r", 36));
      values = await until("the WebKit form filled", async () => ((await read())?.street ? read() : null), 4000).catch(() => null);
    }
    values ??= await read();
    return values;
  } finally {
    await closeTab(id);
  }
}

try {
  writeCard(TWO_ADDRESSES);
  app = await launch(appPath, {
    data,
    fresh: true,
    onboarded: true,
    metroPort,
    test: { meCard: fixture },
    ready: { timeout: 60000, test: "return ac.store.getState().windowOrder.length > 0" },
  });

  await check("E28 a Me card with two street addresses becomes two saved entries, one with no address becomes one", async () => {
    const turned = await switchMeCard(true);
    if (!turned.on) throw new Error(`the switch didn't stay on: ${q(turned)}`);
    const two = await until("two entries from Contacts", async () => {
      const got = await contactEntries();
      return got.length === 2 && got.every((e) => !e.missing) ? got : null;
    });
    const wantTwo = [expectedEntry(TWO_ADDRESSES, HOME), expectedEntry(TWO_ADDRESSES, WORK)];
    if (!sameEntries(two.map(shapeOf), wantTwo)) throw new Error(`entries ${q(two.map(shapeOf))}, wanted ${q(wantTwo)}`);

    await switchMeCard(false);
    writeCard(NO_ADDRESS);
    await switchMeCard(true);
    const one = await until("one entry from Contacts", async () => {
      const got = await contactEntries();
      return got.length === 1 && !got[0].missing ? got : null;
    });
    const wantOne = [expectedEntry(NO_ADDRESS, null)];
    if (!sameEntries(one.map(shapeOf), wantOne)) throw new Error(`entry ${q(one.map(shapeOf))}, wanted ${q(wantOne)}`);

    await switchMeCard(false);
    writeCard(TWO_ADDRESSES);
    await switchMeCard(true);
    await until("two entries again", async () => ((await contactEntries()).length === 2 ? true : null));
    return { two: two.length, one: one.length };
  });

  await check("E29 a Me card entry fills name, company, email, phone and address in a Chromium tab", async () => {
    const values = await fillInChromium();
    const wrong = filledLike(values, TWO_ADDRESSES);
    if (wrong) throw new Error(`${wrong}; form ${q(values)}`);
    return values;
  });

  await check("E29 a Me card entry fills name, company, email, phone and address in a WebKit tab", async () => {
    await app.eval(`globalThis.__meCardFills = []; ac.engine.on("webKit.counted", (e) => e.name === "autofillAddressFill" && globalThis.__meCardFills.push(e.entry ?? null)); return true`);
    const values = await fillInWebKit();
    const wrong = filledLike(values, TWO_ADDRESSES);
    if (wrong) throw new Error(`${wrong}; form ${q(values)}`);
    const ids = (await fromContactsIds()) ?? [];
    const counted = await until("the fill counted with its entry", async () => {
      const entries = await app.eval(`return globalThis.__meCardFills`);
      return entries?.some((id) => ids.includes(id)) ? entries : null;
    }, 4000);
    return { ...values, counted: counted.length };
  });

  await check("E30 changing the Me card updates the entries; turning the switch off removes them", async () => {
    await engine("autofill.saveAddress", { profile: PROFILE, address: { name: "Grace Hopper", street: "1 Navy Way", city: "Arlington", state: "VA", postalCode: "22202", country: "US" } });
    writeCard(CHANGED);
    const changed = await until("the entries to follow the changed card", async () => {
      const got = await contactEntries();
      return got.length === 1 && !got[0].missing && digits(got[0].phone).endsWith("4155550199") ? got : null;
    }, 15000);
    const want = [expectedEntry(CHANGED, HOME)];
    if (!sameEntries(changed.map(shapeOf), want)) throw new Error(`entries ${q(changed.map(shapeOf))}, wanted ${q(want)}`);
    const ids = changed.map((e) => e.id);
    const turned = await switchMeCard(false);
    if (turned.on) throw new Error("the switch stayed on");
    const left = await until("the entries removed", async () => {
      const all = await addresses();
      return all.some((a) => ids.includes(a.id)) ? null : all;
    });
    if (left.length !== 1 || left[0].name !== "Grace Hopper") throw new Error(`left ${q(left)}`);
    if ((await fromContactsIds()) !== null) throw new Error("the sidecar still lists entries");
    return { updated: changed.length, left: left.length };
  });
} catch (e) {
  rep.record("me-card-test setup", { error: e });
} finally {
  if (app) await app.quit().catch(() => app.kill());
  server.close();
  const passed = rep.summary();
  if (!keep) rmSync(scratch, { recursive: true, force: true });
  else console.log(`kept ${scratch}`);
  process.exitCode = passed ? 0 : 1;
}

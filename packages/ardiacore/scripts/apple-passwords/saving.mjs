import { FIXTURES } from "./fake.mjs";
import { waitFor } from "./webkit.mjs";

const q = JSON.stringify;
export const CONNECT_TITLE = "Connect Apple Passwords?";
export const CONNECT_ACTION = "Connect";
export const NOT_SAVED_TITLE = "Not saved to Apple Passwords";
const SITE = "save.localhost";
const PLAIN_SITE = "plain-save.localhost";
const SETTLED_MS = 6000;
const HANDED_MS = 2500;
const SAVE_CMD = 6;

const assert = (ok, message, detail) => {
  if (!ok) throw new Error(`${message}: ${q(detail)}`);
};

export const helperAsked = (fake, user, { since = 0, timeout = 20_000 } = {}) =>
  waitFor(`Apple Passwords' own save window asking about ${user}`, async () => fake.asked().slice(since).find((a) => a.user === user) ?? null, timeout);

export const savesSent = (fake) => fake.requests().filter((r) => r.cmd === SAVE_CMD).length;

export async function noPrompt(tab, ms = SETTLED_MS) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const prompt = await tab.prompt();
    if (prompt) return prompt;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

export async function handedOver(tab, fake, user, { since = 0 } = {}) {
  const asked = await helperAsked(fake, user, { since });
  const shown = await noPrompt(tab, HANDED_MS);
  assert(!shown, "Ardia shows no prompt of its own and claims nothing once Apple Passwords asks", shown);
  return asked;
}

export async function signIn(tab, user, password, landing = "/signed-in") {
  await tab.click("#u");
  await tab.type(user);
  await tab.click("#p");
  await tab.type(password);
  await waitFor("the Sign in button enabled", () => tab.value(`!document.getElementById("go").disabled || null`), 5000);
  await tab.value(`(document.documentElement.dataset.signingIn = "yes")`);
  await tab.click("#go");
  await waitFor("the page after signing in", () => tab.value(`!document.documentElement.dataset.signingIn && location.pathname === ${q(landing)} && document.readyState === "complete" || null`), 20_000);
}

export const promptShown = (tab, what = "the save prompt") => waitFor(what, () => tab.prompt(), 20_000);

export function savingChecks({ paired, sites, engine: engineName = "webkit" }) {
  const session = async () => {
    const shared = await paired();
    return { ...shared, tabs: engineName === "chromium" ? shared.chromium : shared.tabs };
  };
  const ardiaStore = async (app) => (await app.eval(`return ac.engine.call("passwords.list", { profile: "" })`, { timeout: 20_000 })).passwords.map((p) => `${p.origin} ${p.username}`).sort();

  const fixture = (user) => FIXTURES.logins.find((l) => l.user === user);
  const applePasswords = (app) => app.eval("return ac.applePasswords.useApplePasswords.getState().state", { timeout: 20_000 });
  const pairingStep = (app) => app.eval("return ac.applePasswords.useApplePasswords.getState().pairing?.step ?? null", { timeout: 20_000 });
  const prompting = (app, tabId) => app.eval(`return ac.pageState.getState().pages[${q(tabId)}]?.applePasswordsPairing === true`, { timeout: 20_000 });
  const unpaired = async (app, fake) => {
    fake.endPairing();
    await waitFor("Pairing ended", async () => ((await applePasswords(app)) === "notConnected" ? true : null), 10_000);
  };

  return {
    async E18() {
      const { app, fake, tabs } = await session();
      const login = { user: `new-${Date.now()}@save.test`, password: "fixture-pw-new-9" };
      const before = await ardiaStore(app);
      const tab = await tabs.open(sites.url(SITE));
      try {
        await signIn(tab, login.user, login.password);
        const asked = await handedOver(tab, fake, login.user);
        assert(asked.site === SITE && !asked.update, "Apple Passwords asks to save the new login for the site", asked);
        const saved = fake.savedLogins().find((l) => l.user === login.user);
        assert(saved?.password === login.password && saved.sites.includes(SITE), "Save Password in Apple Passwords' window stores it", { sites: saved?.sites });
        const after = await ardiaStore(app);
        assert(q(after) === q(before), "Ardia's own store is unchanged", { before, after });
        return { engine: engineName, asked: asked.site, ardiaStore: after.length };
      } finally {
        await tab.close();
      }
    },
    async E18notNow() {
      const { fake, tabs } = await session();
      const login = { user: `declined-${engineName}-${Date.now()}@save.test`, password: "fixture-pw-declined-20" };
      const tab = await tabs.open(sites.url(SITE));
      try {
        fake.setMode({ saveChoice: "notNow" });
        await signIn(tab, login.user, login.password);
        const asked = await handedOver(tab, fake, login.user);
        assert(asked.choice === "notNow", "the user clicks Not Now in Apple Passwords' window", asked);
        assert(!fake.savedLogins().some((l) => l.user === login.user), "Not Now leaves nothing in Apple Passwords", null);
        const since = fake.asked().length;
        await tab.navigate(sites.url(SITE));
        await signIn(tab, login.user, login.password);
        await handedOver(tab, fake, login.user, { since });
        assert(!fake.savedLogins().some((l) => l.user === login.user), "still nothing stored", null);
        return { engine: engineName, asked: fake.asked().filter((a) => a.user === login.user).length };
      } finally {
        fake.setMode({ saveChoice: "save" });
        await tab.close();
      }
    },
    async E39() {
      const { app, fake, tabs } = await session();
      const login = { user: `toggled-${Date.now()}@save.test`, password: "fixture-pw-toggled-4" };
      const choose = (manager) => app.eval(`ac.passwordManager.choosePasswordManager(ac.store.getState().settings.defaultProfileId, ${q(manager)}); return true;`);
      await choose("ardia");
      await app.eval(`return ac.settingsData.setPasswordAutofillFor("", false).then(() => true)`, { timeout: 20_000 });
      await choose("apple");
      const tab = await tabs.open(sites.url(SITE));
      try {
        await signIn(tab, login.user, login.password);
        const asked = await handedOver(tab, fake, login.user);
        assert(fake.savedLogins().some((l) => l.user === login.user), "with Save and fill passwords stored off, the login still reaches Apple Passwords", asked);
        return { engine: engineName, asked: asked.site };
      } finally {
        await tab.close();
        await choose("ardia");
        await app.eval(`return ac.settingsData.setPasswordAutofillFor("", true).then(() => true)`, { timeout: 20_000 });
        await choose("apple");
      }
    },
    async E19() {
      const { app, fake, tabs } = await session();
      const kept = fixture("changed@save.test");
      const changed = `fixture-pw-changed-${Date.now()}`;
      const before = await ardiaStore(app);
      const tab = await tabs.open(sites.url(SITE));
      try {
        await signIn(tab, kept.user, changed);
        const asked = await handedOver(tab, fake, kept.user);
        assert(asked.update, "Apple Passwords asks to update the kept login", asked);
        assert(fake.savedLogins().find((l) => l.user === kept.user)?.password === changed, "the changed password is in Apple Passwords", null);
        const copies = fake.savedLogins().filter((l) => l.user === kept.user);
        assert(copies.length === 1, "the login is changed, not added again", copies.length);
        const after = await ardiaStore(app);
        assert(q(after) === q(before), "Ardia's own store is unchanged", { before, after });
        return { engine: engineName, update: asked.update };
      } finally {
        await tab.close();
      }
    },
    async E20() {
      const { fake, tabs } = await session();
      const kept = fixture("same@save.test");
      const tab = await tabs.open(sites.url(SITE));
      try {
        const sent = savesSent(fake);
        await signIn(tab, kept.user, kept.password);
        const prompt = await noPrompt(tab);
        assert(!prompt, "signing in with the saved password shows no prompt", prompt);
        assert(savesSent(fake) === sent, "and sends Apple Passwords no save", null);
        return { engine: engineName, prompt: "none" };
      } finally {
        await tab.close();
      }
    },
    async E21() {
      const { fake, tabs } = await session();
      const login = { user: `typo-${Date.now()}@save.test`, password: "fixture-pw-typo-11" };
      const tab = await tabs.open(sites.url(SITE, "/login-fails"));
      try {
        await signIn(tab, login.user, login.password, "/login-fails");
        await waitFor("the sign-in form back", () => tab.value(`!!document.getElementById("p") || null`), 10_000);
        const prompt = await noPrompt(tab);
        assert(!prompt, "a sign-in whose form comes back shows no prompt", prompt);
        assert(!fake.asked().some((a) => a.user === login.user), "Apple Passwords is never asked", null);
        assert(!fake.savedLogins().some((l) => l.user === login.user), "nothing reaches Apple Passwords", null);
        return { engine: engineName, prompt: "none" };
      } finally {
        await tab.close();
      }
    },
    async E22() {
      const { fake, tabs } = await session();
      const login = { user: `refused-${Date.now()}@save.test`, password: "fixture-pw-refused-12" };
      const tab = await tabs.open(sites.url(SITE));
      try {
        fake.setMode({ status: { 6: 5 } });
        await signIn(tab, login.user, login.password);
        const told = await promptShown(tab, "the prompt saying it wasn't saved");
        assert(told.copy.title === NOT_SAVED_TITLE && told.state === "notSaved", `the prompt says ${NOT_SAVED_TITLE}`, told);
        assert(!fake.savedLogins().some((l) => l.user === login.user), "nothing reached Apple Passwords", null);
        assert(await tab.answer("dismiss"), "OK closes it", null);
        assert(!(await tab.prompt()), "the prompt is gone", null);
        return { engine: engineName, title: told.copy.title, message: told.copy.message };
      } finally {
        fake.setMode({ status: {} });
        await tab.close();
      }
    },
    async E20unread() {
      const { fake, tabs } = await session();
      const kept = fixture("unread@save.test");
      const changed = `fixture-pw-unread-${engineName}-${Date.now()}`;
      const tab = await tabs.open(sites.url(SITE));
      try {
        fake.setMode({ status: { 5: 2 } });
        await signIn(tab, kept.user, changed);
        const asked = await handedOver(tab, fake, kept.user);
        assert(asked.update, "a sign-in whose kept password can't be read is still handed to Apple Passwords, which asks to update", asked);
        assert(fake.savedLogins().find((l) => l.user === kept.user)?.password === changed, "the new password is in Apple Passwords", null);
        return { engine: engineName, update: asked.update };
      } finally {
        fake.setMode({ status: {} });
        await tab.close();
      }
    },
    async E22garbled() {
      const { fake, tabs } = await session();
      const kept = fixture("garbled@save.test");
      const changed = `fixture-pw-garbled-${engineName}-${Date.now()}`;
      const held = fake.savedLogins().find((l) => l.user === kept.user)?.password;
      const tab = await tabs.open(sites.url(SITE));
      try {
        fake.setMode({ garble: { 6: true } });
        await signIn(tab, kept.user, changed);
        const told = await promptShown(tab, "the prompt saying it wasn't saved");
        assert(told.copy.title === NOT_SAVED_TITLE && told.state === "notSaved", `an unreadable reply to a save says ${NOT_SAVED_TITLE}`, told);
        assert(await tab.answer("dismiss"), "OK closes it", null);
        fake.setMode({ garble: {} });
        assert(fake.savedLogins().find((l) => l.user === kept.user)?.password === held, "Apple Passwords still holds the old password", null);
        const since = fake.asked().length;
        await tab.navigate(sites.url(SITE));
        await signIn(tab, kept.user, changed);
        const again = await handedOver(tab, fake, kept.user, { since });
        assert(again.update, "the failed save was not remembered, so signing in with that password asks Apple Passwords again", again);
        return { engine: engineName, title: told.copy.title };
      } finally {
        fake.setMode({ garble: {} });
        await tab.close();
      }
    },
    async E18notConnected() {
      const { app, fake, tabs } = await session();
      const seen = {};
      await unpaired(app, fake);
      const login = { user: `unpaired-${engineName}-${Date.now()}@save.test`, password: "fixture-pw-unpaired-17" };
      const tab = await tabs.open(sites.url(SITE));
      try {
        await signIn(tab, login.user, login.password);
        const prompt = await promptShown(tab);
        assert(prompt.state === "save" && prompt.copy.title === CONNECT_TITLE && prompt.username === login.user, `signing in while Apple Passwords isn't connected asks ${CONNECT_TITLE}`, prompt);
        assert(prompt.action === CONNECT_ACTION, `its button reads ${CONNECT_ACTION}`, prompt.action);
        assert(await tab.answer("save"), `${CONNECT_ACTION} is pressed`, null);
        await waitFor("the Pairing prompt over the page", async () => ((await prompting(app, tab.id)) ? true : null), 10_000);
        await waitFor("the code step", async () => ((await pairingStep(app)) === "code" ? true : null), 20_000);
        assert(!fake.savedLogins().some((l) => l.user === login.user), "nothing is saved before Pairing", null);
        await app.eval(`return ac.applePasswords.submitApplePasswordsCode(ac.applePasswords.pairingCodeSecret(${q(FIXTURES.code)})).then(() => true);`, { timeout: 60_000 });
        await handedOver(tab, fake, login.user);
        const saved = fake.savedLogins().find((l) => l.user === login.user);
        assert(saved?.password === login.password && saved.sites.includes(SITE), "once paired, Apple Passwords asks about the held login and stores it", { sites: saved?.sites });
        seen.paired = "asked";
      } finally {
        await tab.close();
      }
      await unpaired(app, fake);
      const cancelled = { user: `cancelled-${engineName}-${Date.now()}@save.test`, password: "fixture-pw-cancelled-18" };
      const again = await tabs.open(sites.url(SITE));
      try {
        await signIn(again, cancelled.user, cancelled.password);
        assert((await promptShown(again)).copy.title === CONNECT_TITLE, `the prompt asks ${CONNECT_TITLE} again`, null);
        assert(await again.answer("save"), `${CONNECT_ACTION} is pressed`, null);
        await waitFor("the Pairing prompt over the page", async () => ((await prompting(app, again.id)) ? true : null), 10_000);
        await app.eval("ac.applePasswords.cancelPairing(); return true;");
        const told = await promptShown(again, "the prompt saying it wasn't saved");
        assert(told.state === "notSaved" && told.copy.title === NOT_SAVED_TITLE, `Cancel says ${NOT_SAVED_TITLE}`, told);
        assert(!fake.savedLogins().some((l) => l.user === cancelled.user), "nothing reached Apple Passwords", null);
        assert(await again.answer("dismiss"), "OK closes it", null);
        seen.cancelled = told.copy.title;
      } finally {
        await again.close();
      }
      await app.eval("return ac.applePasswords.startApplePasswordsPairing(null).then(() => true);", { timeout: 30_000 });
      await waitFor("the code step", async () => ((await pairingStep(app)) === "code" ? true : null), 20_000);
      await app.eval(`return ac.applePasswords.submitApplePasswordsCode(ac.applePasswords.pairingCodeSecret(${q(FIXTURES.code)})).then(() => true);`, { timeout: 60_000 });
      await waitFor("Paired again", async () => ((await applePasswords(app)) === "connected" ? true : null), 20_000);
      return { engine: engineName, ...seen };
    },
    async E18never() {
      const { app, fake, tabs } = await session();
      const site = `never-${engineName}.localhost`;
      await unpaired(app, fake);
      const first = { user: `never-${engineName}-${Date.now()}@save.test`, password: "fixture-pw-never-22" };
      const tab = await tabs.open(sites.url(site));
      try {
        await signIn(tab, first.user, first.password);
        const prompt = await promptShown(tab);
        assert(prompt.state === "save" && prompt.copy.title === CONNECT_TITLE, `signing in while Apple Passwords isn't connected asks ${CONNECT_TITLE}`, prompt);
        assert(await tab.answer("never"), "Never on This Site is pressed", null);
        await app.eval("return ac.applePasswords.startApplePasswordsPairing(null).then(() => true);", { timeout: 30_000 });
        await waitFor("the code step", async () => ((await pairingStep(app)) === "code" ? true : null), 20_000);
        await app.eval(`return ac.applePasswords.submitApplePasswordsCode(ac.applePasswords.pairingCodeSecret(${q(FIXTURES.code)})).then(() => true);`, { timeout: 60_000 });
        await waitFor("Paired again", async () => ((await applePasswords(app)) === "connected" ? true : null), 20_000);
        const sent = savesSent(fake);
        const later = { user: `never-again-${engineName}-${Date.now()}@save.test`, password: "fixture-pw-never-23" };
        await tab.navigate(sites.url(site));
        await signIn(tab, later.user, later.password);
        const shown = await noPrompt(tab);
        assert(!shown, "a site set to Never on This Site shows no prompt", shown);
        assert(savesSent(fake) === sent, "and sends Apple Passwords no save", savesSent(fake) - sent);
        assert(!fake.asked().some((a) => a.user === first.user || a.user === later.user), "Apple Passwords is never asked", null);
        return { engine: engineName, prompt: "none", sent: 0 };
      } finally {
        await tab.close();
      }
    },
    async E33() {
      const { fake, tabs } = await session();
      const login = { user: `http-${engineName}-${Date.now()}@plain.test`, password: "fixture-pw-http-14" };
      const tab = await tabs.open(sites.url(PLAIN_SITE));
      try {
        const sent = savesSent(fake);
        await signIn(tab, login.user, login.password);
        const asked = await handedOver(tab, fake, login.user);
        assert(asked.site === PLAIN_SITE, "a login from an http page goes to Apple Passwords under its bare host, as Apple's extension sends it", asked);
        const hosts = fake.requests().filter((r) => r.cmd === SAVE_CMD).slice(sent).map((r) => r.host);
        assert(hosts.length === 1 && hosts[0] === PLAIN_SITE, "the one save request names the bare host", hosts);
        return { engine: engineName, site: asked.site };
      } finally {
        await tab.close();
      }
    },
    async E23() {
      const { fake, tabs } = await session();
      const kept = fixture("same@save.test");
      const login = { user: `private-${Date.now()}@save.test`, password: "fixture-pw-private-13" };
      const tab = await tabs.open(sites.url(SITE), { kind: "private" });
      try {
        await tab.click("#u");
        const rows = await tab.waitRows();
        assert(rows.some((r) => r.title === kept.user), "the Login list lists the site's Apple Passwords logins", rows);
        await tab.pick(kept.user);
        const filled = await waitFor("the filled login", async () => {
          const page = await tab.value(`({ u: document.getElementById("u").value, p: document.getElementById("p").value })`);
          return page?.p ? page : null;
        });
        assert(filled.u === kept.user && filled.p === kept.password, "the picked login fills in the private window", { u: filled.u, filled: !!filled.p });
        await tab.value(`(document.getElementById("u").value = "", document.getElementById("p").value = "", true)`);
        await signIn(tab, login.user, login.password);
        const prompt = await noPrompt(tab);
        assert(!prompt, "a new login in a private window shows no save prompt", prompt);
        assert(!fake.asked().some((a) => a.user === login.user), "and Apple Passwords is never asked", null);
        assert(!fake.savedLogins().some((l) => l.user === login.user), "nothing reaches Apple Passwords", null);
        return { engine: engineName, filled: filled.u, prompt: "none" };
      } finally {
        await tab.close();
      }
    },
  };
}

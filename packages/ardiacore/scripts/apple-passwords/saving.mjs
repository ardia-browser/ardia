import { FIXTURES } from "./fake.mjs";
import { waitFor } from "./webkit.mjs";

const q = JSON.stringify;
export const SAVE_TITLE = "Save to Apple Passwords?";
export const UPDATE_TITLE = "Update in Apple Passwords?";
export const NOT_SAVED_TITLE = "Not saved to Apple Passwords";
const SITE = "save.localhost";
const SETTLED_MS = 6000;

const assert = (ok, message, detail) => {
  if (!ok) throw new Error(`${message}: ${q(detail)}`);
};

export function savingChecks({ paired, sites, engine: engineName = "webkit" }) {
  const ardiaStore = async (app) => (await app.eval(`return ac.engine.call("passwords.list", { profile: "" })`, { timeout: 20_000 })).passwords.map((p) => `${p.origin} ${p.username}`).sort();

  async function signIn(tab, user, password, landing = "/signed-in") {
    await tab.click("#u");
    await tab.type(user);
    await tab.click("#p");
    await tab.type(password);
    await waitFor("the Sign in button enabled", () => tab.value(`!document.getElementById("go").disabled || null`), 5000);
    await tab.value(`(document.documentElement.dataset.signingIn = "yes")`);
    await tab.click("#go");
    await waitFor("the page after signing in", () => tab.value(`!document.documentElement.dataset.signingIn && location.pathname === ${q(landing)} && document.readyState === "complete" || null`), 20_000);
  }

  const promptShown = (tab, what = "the save prompt") => waitFor(what, () => tab.prompt(), 20_000);
  const noPrompt = async (tab, ms = SETTLED_MS) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const prompt = await tab.prompt();
      if (prompt) return prompt;
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  };
  const fixture = (user) => FIXTURES.logins.find((l) => l.user === user);

  return {
    async E18() {
      const { app, fake, tabs } = await paired();
      const login = { user: `new-${Date.now()}@save.test`, password: "fixture-pw-new-9" };
      const before = await ardiaStore(app);
      const tab = await tabs.open(sites.url(SITE));
      try {
        await signIn(tab, login.user, login.password);
        const prompt = await promptShown(tab);
        assert(prompt.state === "save" && prompt.username === login.user, "the prompt offers to save the new login", prompt);
        assert(prompt.copy.title === SAVE_TITLE, `the prompt asks ${SAVE_TITLE}`, prompt.copy);
        assert(await tab.answer("save"), "Save is pressed", null);
        const saved = await waitFor("the login in Apple Passwords", async () => fake.savedLogins().find((l) => l.user === login.user) ?? null, 20_000);
        assert(saved.password === login.password && saved.sites.includes(SITE), "Save puts the login in Apple Passwords", { user: saved.user, sites: saved.sites });
        const after = await ardiaStore(app);
        assert(q(after) === q(before), "Ardia's own store is unchanged", { before, after });
        return { engine: engineName, title: prompt.copy.title, ardiaStore: after.length };
      } finally {
        await tab.close();
      }
    },
    async E19() {
      const { fake, tabs } = await paired();
      const kept = fixture("changed@save.test");
      const changed = "fixture-pw-changed-10";
      const tab = await tabs.open(sites.url(SITE));
      try {
        await signIn(tab, kept.user, changed);
        const prompt = await promptShown(tab, "the update prompt");
        assert(prompt.state === "update" && prompt.username === kept.user, "the prompt offers to update the saved login", prompt);
        assert(prompt.copy.title === UPDATE_TITLE, `the prompt asks ${UPDATE_TITLE}`, prompt.copy);
        assert(await tab.answer("update"), "Update is pressed", null);
        await waitFor("the changed password in Apple Passwords", async () => (fake.savedLogins().find((l) => l.user === kept.user)?.password === changed ? true : null), 20_000);
        const copies = fake.savedLogins().filter((l) => l.user === kept.user);
        assert(copies.length === 1, "the login is changed, not added again", copies.length);
        return { engine: engineName, title: prompt.copy.title };
      } finally {
        await tab.close();
      }
    },
    async E20() {
      const { tabs } = await paired();
      const kept = fixture("same@save.test");
      const tab = await tabs.open(sites.url(SITE));
      try {
        await signIn(tab, kept.user, kept.password);
        const prompt = await noPrompt(tab);
        assert(!prompt, "signing in with the saved password shows no prompt", prompt);
        return { engine: engineName, prompt: "none" };
      } finally {
        await tab.close();
      }
    },
    async E21() {
      const { fake, tabs } = await paired();
      const login = { user: `typo-${Date.now()}@save.test`, password: "fixture-pw-typo-11" };
      const tab = await tabs.open(sites.url(SITE, "/login-fails"));
      try {
        await signIn(tab, login.user, login.password, "/login-fails");
        await waitFor("the sign-in form back", () => tab.value(`!!document.getElementById("p") || null`), 10_000);
        const prompt = await noPrompt(tab);
        assert(!prompt, "a sign-in whose form comes back shows no prompt", prompt);
        assert(!fake.savedLogins().some((l) => l.user === login.user), "nothing reaches Apple Passwords", null);
        return { engine: engineName, prompt: "none" };
      } finally {
        await tab.close();
      }
    },
    async E22() {
      const { fake, tabs } = await paired();
      const login = { user: `refused-${Date.now()}@save.test`, password: "fixture-pw-refused-12" };
      const tab = await tabs.open(sites.url(SITE));
      try {
        await signIn(tab, login.user, login.password);
        const offered = await promptShown(tab);
        assert(offered.state === "save" && offered.copy.title === SAVE_TITLE, "the prompt offers to save", offered);
        fake.setMode({ status: { 6: 5 } });
        assert(await tab.answer("save"), "Save is pressed", null);
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
    async E23() {
      const { fake, tabs } = await paired();
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
        assert(!fake.savedLogins().some((l) => l.user === login.user), "nothing reaches Apple Passwords", null);
        return { engine: engineName, filled: filled.u, prompt: "none" };
      } finally {
        await tab.close();
      }
    },
  };
}

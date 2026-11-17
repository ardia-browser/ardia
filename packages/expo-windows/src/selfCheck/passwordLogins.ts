import type { AppNative } from "@ardia/shell";
import { engineAvailable, engineCallJson } from "../engine/host";
import { isFields, type Fields } from "../engine/domains/calling";
import { requireNativeModule } from "../modules";
import { expectEqual, expectTrue, type Check } from "./check";
import { linkPeekStage } from "./engineLinkPeekStage";

const ONE = { origin: "https://ardia-self-check-one.example", username: "one", password: "self-check-one" };
const TWO = { origin: "https://ardia-self-check-two.example", username: "two", password: "self-check-two" };
const OURS = "ardia-self-check-";

const call = async (name: string, args: object = {}): Promise<Fields> => {
  const reply: unknown = JSON.parse(await engineCallJson(name, "", JSON.stringify(args)));
  if (!isFields(reply)) throw new Error(`${name} answered something that isn't an object`);
  return reply;
};

const nameOf = (realm: unknown) => new RegExp(`${OURS}([a-z]+)\\.`).exec(String(realm ?? ""))?.[1];

const entries = (list: unknown, origin: "realm" | "origin", label: (entry: Fields, name: string) => string = (_, name) => name) =>
  Array.isArray(list)
    ? list
        .filter(isFields)
        .flatMap((entry) => {
          const name = nameOf(entry[origin]);
          return name === undefined ? [] : [label(entry, name)];
        })
        .sort()
    : null;

const loginLabel = (entry: Fields, name: string) => {
  if (entry.passwordless === true && !("password" in entry)) return `${name}, passwordless`;
  return typeof entry.password === "string" && entry.password.length > 0 ? name : `${name}, malformed`;
};

const syncRead = async () => {
  const reply = await call("ac_passwords_logins");
  return reply.error !== undefined ? { error: reply.error } : { logins: entries(reply.logins, "realm", loginLabel) };
};

const settingsList = async () => {
  const reply = await call("ac_passwords_list");
  return reply.error !== undefined ? { error: reply.error } : { passwords: entries(reply.passwords, "origin")?.filter((name) => name === "one" || name === "two") ?? null };
};

const savedChecks: Check[] = [
  {
    name: "passwords: Sync's login read lists every saved login, as Settings does",
    async run() {
      for (const login of [ONE, TWO]) expectEqual((await call("ac_passwords_add", login)).error, undefined, `the error saving ${login.origin}`);
      expectEqual(await syncRead(), { logins: ["one", "two"] }, "ac_passwords_logins");
      expectEqual(await settingsList(), { passwords: ["one", "two"] }, "ac_passwords_list");
    },
  },
];

const stages: Record<string, Check[]> = {
  linkPeeks: linkPeekStage,
  blocklistedAndFederated: [
    {
      name: "passwords: a site never to save and a federated sign-in, both stored with no password, leave Sync's read whole and out of its list",
      async run() {
        expectEqual(await syncRead(), { logins: ["one", "two"] }, "ac_passwords_logins with a blocklisted and a federated row");
      },
    },
  ],
  undecryptableLogin: [
    {
      name: "passwords: with one saved login that can't be decrypted, Sync's read fails as undecryptable while Settings still lists the other",
      async run() {
        expectEqual(await syncRead(), { error: "undecryptable" }, "ac_passwords_logins with a corrupt row");
        expectEqual(await settingsList(), { passwords: ["one"] }, "ac_passwords_list with a corrupt row");
      },
    },
  ],
  emptyPasswordLogin: [
    {
      name: "passwords: a saved login whose stored password is empty is listed as passwordless, so Sync's read stays whole and the other login is listed as it is",
      async run() {
        expectEqual(await syncRead(), { logins: ["one", "two, passwordless"] }, "ac_passwords_logins with an empty password blob");
        const settings = await settingsList();
        expectTrue(Array.isArray(settings.passwords) && settings.passwords.includes("one"), `ac_passwords_list with an empty password blob gave ${JSON.stringify(settings)}`);
      },
    },
  ],
  undecryptableRemoved: [
    {
      name: "passwords: once the login that couldn't be decrypted is gone, Sync's read lists the rest again",
      async run() {
        expectEqual(await syncRead(), { logins: ["one"] }, "ac_passwords_logins after the corrupt row was removed");
      },
    },
  ],
};

export const checks: Check[] = engineAvailable() ? savedChecks : [];

export function stageChecks(): Check[] | null {
  const stage = requireNativeModule<Pick<AppNative, "launchConfig">>("ArdiaApp").launchConfig().test?.selfCheckStage;
  return typeof stage === "string" && stage ? (stages[stage] ?? []) : null;
}

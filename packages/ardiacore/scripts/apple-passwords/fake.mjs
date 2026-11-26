import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const HOST_NAME = "com.apple.passwordmanager";
export const ORIGIN = "chrome-extension://pejdijmoenmkgeppbflobdenhhabjlaj/";

export const FIXTURES = {
  code: "482916",
  logins: [
    { user: "ada@example.test", password: "fixture-pw-ada-1", sites: ["example.test"] },
    { user: "grace@example.test", password: "fixture-pw-grace-2", sites: ["example.test"] },
    { user: "linus@other.test", password: "fixture-pw-linus-3", sites: ["other.test"] },
    { user: "plain@plain.test", password: "fixture-pw-plain-4", sites: ["plain.test"] },
  ],
  codes: [
    { domain: "example.test", username: "ada@example.test", code: "135790" },
    { domain: "example.test", username: "grace@example.test", code: "246802" },
  ],
};

const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

export function fakeHelper(dir, { fixtures = FIXTURES, mode = {} } = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const file = (name) => path.join(dir, name);
  const wrapper = file("helper");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(path.join(HERE, "fake-helper.mjs"))} ${shellQuote(dir)} "$@"\n`, { mode: 0o755 });
  const manifest = file(`${HOST_NAME}.json`);
  fs.writeFileSync(manifest, JSON.stringify({ name: HOST_NAME, description: "fake Apple Passwords helper", path: wrapper, type: "stdio", allowed_origins: [ORIGIN] }, null, 2));
  fs.writeFileSync(file("fixtures.json"), JSON.stringify(fixtures, null, 2));
  fs.writeFileSync(file("mode.json"), JSON.stringify(mode));
  const lines = (name) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), "utf8").split("\n").filter(Boolean) : []);
  return {
    dir,
    manifest,
    fixtures,
    setMode: (patch) => fs.writeFileSync(file("mode.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync(file("mode.json"), "utf8")), ...patch })),
    endPairing: () => {
      const now = JSON.parse(fs.readFileSync(file("mode.json"), "utf8"));
      fs.writeFileSync(file("mode.json"), JSON.stringify({ ...now, endPairing: (now.endPairing ?? 0) + 1 }));
    },
    launches: () => lines("started").length,
    requests: () => lines("requests.jsonl").map((l) => JSON.parse(l)),
    savedLogins: () => JSON.parse(fs.readFileSync(file("fixtures.json"), "utf8")).logins,
  };
}

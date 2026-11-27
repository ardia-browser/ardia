import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const NO_METRO = "127.0.0.1:1";

export const INJECTION_ENTITLEMENTS = ["com.apple.security.cs.allow-dyld-environment-variables", "com.apple.security.cs.disable-library-validation"];

const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const copiesToUnregister = new Set();
process.on("exit", () => {
  for (const copy of copiesToUnregister) spawnSync(LSREGISTER, ["-u", copy], { stdio: "ignore" });
});

export const CODESIGN_TIMEOUT_MS = 120000;
export const COPY_TIMEOUT_MS = 600000;
export function identityFromCodesign(result, app = "the app") {
  if (result.error) throw new Error(`codesign could not read ${app}'s signature: ${result.error.code ?? result.error.message}`);
  if (result.status !== 0) throw new Error(`codesign -dvv ${app} exited ${result.status ?? result.signal}: ${String(result.stderr ?? "").trim()}`);
  return String(result.stderr ?? "").match(/^Authority=(.+)$/m)?.[1] ?? "-";
}
export const signingIdentity = (app) => identityFromCodesign(spawnSync("codesign", ["-dvv", app], { encoding: "utf8", timeout: CODESIGN_TIMEOUT_MS }), app);

const DEBUG_ENTITLEMENT = "com.apple.security.get-task-allow";

export function untouchedCopy({ source, bundle, granted, missing }) {
  if (missing.length) return false;
  if (!bundle) return true;
  if (granted.includes(`<key>${DEBUG_ENTITLEMENT}</key>`)) return false;
  const shipped = join(source, "Contents/Resources/main.jsbundle");
  return existsSync(shipped) && (realpathSync(bundle) === realpathSync(shipped) || readFileSync(bundle).equals(readFileSync(shipped)));
}

const sealIntact = (app) => spawnSync("codesign", ["--verify", "--strict", "--deep", app], { stdio: "ignore", timeout: CODESIGN_TIMEOUT_MS }).status === 0;

const cdhashOf = (app) => spawnSync("codesign", ["-dvvv", app], { encoding: "utf8", timeout: CODESIGN_TIMEOUT_MS }).stderr.match(/^CDHash=(\w+)$/m)?.[1] ?? null;

const SHIPPED_BUNDLE = "Contents/Resources/main.jsbundle";
function sameBundle(copy, wanted) {
  const held = join(copy, SHIPPED_BUNDLE);
  if (!existsSync(held) || !existsSync(wanted)) return !existsSync(held) && !existsSync(wanted);
  return readFileSync(held).equals(readFileSync(wanted));
}

const resignNeeded = (source) => new Error(`${source}'s signature doesn't cover its contents (was a resource edited without re-signing?): re-sign the source app`);

function reuseOrClone(source, dir, copy, bundle) {
  const stampFile = join(dir, "source.txt");
  const hash = cdhashOf(source);
  const stamp = `${source}\n${hash}\n`;
  copiesToUnregister.add(copy);
  if (hash && existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp && cdhashOf(copy) === hash && sameBundle(copy, bundle ?? join(source, SHIPPED_BUNDLE)) && sealIntact(copy)) {
    if (!sealIntact(source)) throw resignNeeded(source);
    return copy;
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execFileSync("cp", ["-cR", source, copy], { timeout: COPY_TIMEOUT_MS });
  if (!sealIntact(copy)) throw resignNeeded(source);
  writeFileSync(stampFile, stamp);
  return copy;
}

export function prepareApp(app, dir, { bundle = null, entitlements: extra = [] } = {}) {
  const installed = (path) => path.startsWith("/Applications/");
  if (installed(resolve(app))) throw new Error(`${app} is installed in /Applications: pass a build or a copy`);
  const source = realpathSync(resolve(app));
  if (installed(source)) throw new Error(`${app} is installed in /Applications: pass a build or a copy`);
  const copy = join(dir, "Ardia.app");
  const granted = execFileSync("codesign", ["-d", "--entitlements", "-", "--xml", source], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: CODESIGN_TIMEOUT_MS });
  const missing = extra.filter((key) => !granted.includes(`<key>${key}</key>`));
  if (untouchedCopy({ source, bundle, granted, missing })) return reuseOrClone(source, dir, copy, bundle);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execFileSync("cp", ["-cR", source, copy], { timeout: COPY_TIMEOUT_MS });
  copiesToUnregister.add(copy);
  const shipped = join(copy, "Contents/Resources/main.jsbundle");
  const swapped = !!bundle && !(existsSync(shipped) && readFileSync(bundle).equals(readFileSync(shipped)));
  if (swapped) cpSync(bundle, shipped);
  if (bundle) writeFileSync(join(copy, "Contents/Resources/ip.txt"), `${NO_METRO}\n`);
  const plist = join(dir, "entitlements.plist");
  writeFileSync(plist, granted.replace(/<\/dict>\s*<\/plist>\s*$/, `${missing.map((key) => `<key>${key}</key><true/>`).join("")}</dict></plist>`));
  execFileSync("codesign", ["--force", "--sign", signingIdentity(source), "--timestamp=none", "--options", "runtime", "--entitlements", plist, copy], { stdio: "inherit", timeout: CODESIGN_TIMEOUT_MS });
  return copy;
}

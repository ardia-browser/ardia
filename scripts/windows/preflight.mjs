import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function evaluate(facts) {
  const checks = [
    ["platform", facts.platform === "win32", "Use a native Windows build host."],
    ["node", Number(facts.node.split(".")[0]) >= 24, "Install Node 24 or later."],
    ["pnpm", facts.pnpm === facts.expectedPnpm, `Install pnpm ${facts.expectedPnpm} from package.json.`],
    ["msvc", Boolean(facts.vs), "Install Visual Studio 2022 or 2026 with MSBuild and Desktop development with C++ (x64/x86 tools). Use build-local.ps1 for Build Tools installations."],
    ["sdk", facts.sdk, `Install Windows SDK ${facts.expectedSdk}.`],
    ["dependencies", facts.dependencies, "Run pnpm install --frozen-lockfile."],
    ["powershell", ["RemoteSigned", "Unrestricted", "Bypass"].includes(facts.policy), "Install PowerShell 7 and use a host whose policy permits local scripts with process-scoped RemoteSigned."],
    ["github-cli", facts.gh, "Install GitHub CLI for scripts/windows/fetch-engine.ps1."],
  ];
  return checks.map(([name, passed, remedy]) => ({ name, passed: Boolean(passed), remedy: passed ? null : remedy }));
}

export function inspect(root, run = spawnSync) {
  const output = (command, args) => {
    const result = run(command, args, { encoding: "utf8", windowsHide: true, timeout: 15000 });
    return result.status === 0 ? result.stdout.trim() : "";
  };
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const project = readFileSync(join(root, "apps/browser/windows/Ardia/Ardia.vcxproj"), "utf8");
  const expectedSdk = project.match(/<WindowsTargetPlatformVersion>([^<]+)</)[1];
  const programs = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const vswhere = join(programs, "Microsoft Visual Studio/Installer/vswhere.exe");
  const localPnpm = join(root, "node_modules/pnpm/bin/pnpm.cjs");
  const pnpm = existsSync(localPnpm)
    ? output(process.execPath, [localPnpm, "--version"])
    : output("cmd.exe", ["/d", "/c", "pnpm --version"]);
  return {
    platform: process.platform,
    node: process.versions.node,
    expectedPnpm: pkg.packageManager.split("@")[1],
    pnpm,
    vs: output(vswhere, ["-latest", "-version", "[17.0,19.0)", "-products", "*", "-requires", "Microsoft.Component.MSBuild", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"]),
    expectedSdk,
    sdk: ["um/Windows.h", "ucrt/stdio.h"].every((file) => existsSync(join(programs, "Windows Kits/10/Include", expectedSdk, file))) && existsSync(join(programs, "Windows Kits/10/Lib", expectedSdk, "um/x64/kernel32.lib")),
    dependencies: existsSync(join(root, "node_modules/react-native-windows/package.json")),
    policy: output("pwsh.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-Command", "Get-ExecutionPolicy"]),
    gh: Boolean(output("gh.exe", ["--version"])),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const facts = inspect(root);
  const checks = evaluate(facts);
  console.log(JSON.stringify({ facts, checks, ready: checks.every((check) => check.passed) }, null, 2));
  process.exitCode = checks.every((check) => check.passed) ? 0 : 1;
}

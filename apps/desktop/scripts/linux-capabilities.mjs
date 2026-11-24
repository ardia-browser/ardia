import { readdirSync, readFileSync } from "node:fs";

const engine = new URL("../../../engine/", import.meta.url);
const engineDirs = ["ardiacore-linux/src/ardia/linux/", "ardiacore-desktop/src/ardia/desktop/"];
const engineFiles = new Map(engineDirs.flatMap((dir) => readdirSync(new URL(dir, engine)).filter((file) => /\.(cc|h)$/.test(file)).map((file) => [`ardia/${dir.split("/ardia/")[1]}${file}`, readFileSync(new URL(`${dir}${file}`, engine), "utf8")])));
const engineSources = [...engineFiles.values()];
const nativeHost = engineFiles.get("ardia/linux/ac_linux_host.cc");
const bootstrap = nativeHost.slice(nativeHost.indexOf("base::DictValue ShellHostView::Bootstrap() const {"), nativeHost.indexOf("void ShellHostView::LayoutOverlay()"));
const capabilityArrays = new Map(engineSources.flatMap((source) => [...source.matchAll(/const char\* (k[A-Za-z]+)\[\] = \{([^}]*)\}/g)].map(([, name, body]) => [name, [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1])])));
const advertisedLoops = [...bootstrap.matchAll(/for \(const char\* \w+ : (?:\w+::)*(k[A-Za-z]+)\)/g)].map((match) => match[1]);

function braced(text, open) {
  let depth = 0;
  for (let at = open; at < text.length; at++) {
    if (text[at] === "{") depth++;
    if (text[at] === "}" && --depth === 0) return text.slice(open + 1, at);
  }
  return "";
}

function helperCapabilities(helper) {
  for (const [path, source] of engineFiles) {
    const definition = new RegExp(`\\bvoid ${helper}\\(base::ListValue& \\w+\\)\\s*\\{`).exec(source);
    if (!definition) continue;
    const body = braced(source, definition.index + definition[0].length - 1);
    const reachable = [path, ...[...source.matchAll(/#include "(ardia\/(?:linux|desktop)\/[\w.]+)"/g)].map((match) => match[1])];
    return [...body.matchAll(/for \(.*? : (?:\w+::)*(k\w+)\)/g)].flatMap(([, array]) => {
      for (const file of reachable) {
        const text = engineFiles.get(file) ?? "";
        const declared = new RegExp(`\\b${array}\\[\\]\\s*=\\s*\\{`).exec(text);
        if (declared) return [...braced(text, declared.index + declared[0].length - 1).matchAll(/"([A-Z][A-Za-z]*\.[a-z][A-Za-z]*)"/g)].map((match) => match[1]);
      }
      return [];
    });
  }
  return [];
}

export const linuxCapabilityHelpers = [...bootstrap.matchAll(/\b(Append\w+Capabilities)\(\w+\);/g)].map((match) => match[1]);

export { advertisedLoops, bootstrap, capabilityArrays, helperCapabilities, nativeHost };

export const linuxAdvertised = [
  ...[...bootstrap.matchAll(/\.Append\("([A-Za-z]+\.[A-Za-z]+)"\)/g)].map((match) => match[1]),
  ...advertisedLoops.flatMap((name) => capabilityArrays.get(name) ?? []),
  ...linuxCapabilityHelpers.flatMap(helperCapabilities),
];

export const linuxRoutedNatively = new Set(engineSources.flatMap((source) => [...source.matchAll(/"(Ardia[A-Za-z]+\.[A-Za-z]+)"/g)].map((match) => match[1])));

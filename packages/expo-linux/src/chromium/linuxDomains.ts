import { callMain, mainModules } from "../bridge";

export const LINUX_DOMAINS = "ArdiaLinuxDomains";

type DomainCall = (verb: string, profile: string, argsJson: string) => Promise<string>;

export const domainOfModule = (name: string) => (name.startsWith("Ardia") && name.length > 5 ? `${name[5]!.toLowerCase()}${name.slice(6)}` : "");

export function linuxVerbs(): Record<string, string[]> {
  const verbs = mainModules()[LINUX_DOMAINS]?.constants?.verbs;
  if (!verbs || typeof verbs !== "object") return {};
  return Object.fromEntries(Object.entries(verbs as Record<string, unknown>).filter((entry): entry is [string, string[]] => Array.isArray(entry[1])));
}

export function withLinuxDomains(modules: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> {
  const verbs = linuxVerbs();
  return Object.fromEntries(
    Object.entries(modules).map(([name, module]) => {
      const domain = domainOfModule(name);
      const own = verbs[domain];
      const fallback = module.call as DomainCall | undefined;
      if (!own?.length || typeof fallback !== "function") return [name, module];
      const call: DomainCall = async (verb, profile, argsJson) => {
        if (!own.includes(verb)) return fallback(verb, profile, argsJson);
        const reply = await callMain<string>(LINUX_DOMAINS, "call", domain, verb, profile, argsJson);
        return typeof reply === "string" ? reply : "null";
      };
      return [name, { ...module, call }];
    }),
  );
}

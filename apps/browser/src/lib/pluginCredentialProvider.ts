import type { CredentialContribution } from "@ardia/plugin-sdk/credential-manifest";

export { CREDENTIAL_PROVIDER_PATH, closedPluginProblems, credentialProviderOf, declaresCredentialProvider } from "@ardia/plugin-sdk/credential-manifest";

export type CredentialProviderSpec = CredentialContribution;

export const CREDENTIAL_MEMORY_MB = [256, 4096] as const;
export const DEFAULT_CREDENTIAL_MB = 1024;

function leadingWords(argv: CredentialProviderSpec["cli"]["verbs"][string]["argv"]): string[] {
  const leading: string[] = [];
  for (const token of argv) {
    if (typeof token !== "string" || token.startsWith("-")) break;
    leading.push(token);
  }
  return leading;
}

const covers = (short: string[], long: string[]) => short.length <= long.length && short.every((word, i) => long[i] === word);

export function verbWords(spec: CredentialProviderSpec): string[] {
  const phrases = Object.values(spec.cli.verbs).map((verb) => leadingWords(verb.argv));
  const words: string[] = [];
  for (const phrase of phrases) {
    const shortest = phrases.filter((other) => covers(other, phrase)).reduce((a, b) => (b.length < a.length ? b : a), phrase);
    const text = shortest.join(" ");
    if (text && !words.includes(text)) words.push(text);
  }
  return words;
}

export const hasSecretField = (spec: CredentialProviderSpec) => spec.signIn.methods.some((m) => m.fields.some((f) => f.type === "secret"));

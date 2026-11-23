import type { CredentialProviderState, VaultProviderState, VaultServerSpec, VaultSignInFieldSpec, VaultSignInMethodSpec } from "../../platform/vaults";

export type { CredentialProviderState, VaultNeeds } from "../../platform/vaults";

export type SignInKind = VaultSignInMethodSpec["kind"];
export type SignInFieldType = VaultSignInFieldSpec["kind"];
export type SignInField = { id: string; title: string; type: SignInFieldType; optional: boolean; placeholder?: string; hint?: string; revealed: boolean; prefill: boolean };
export type SignInMethod = { id: string; title: string; kind: SignInKind; fields: SignInField[]; appURL?: string; appTitle?: string };
export type SignInServer = { id: string; title: string; url?: string; custom: { title: string; placeholder?: string } | null };

const CUSTOM_SERVER_TITLE = "Server URL";

export const credential = (p: VaultProviderState): CredentialProviderState => p;

export const titleOf = (p: Pick<CredentialProviderState, "title" | "name">) => p.title || p.name;

const fieldOf = (field: VaultSignInFieldSpec): SignInField => ({
  id: field.id,
  title: field.title,
  type: field.kind,
  optional: field.optional === true,
  placeholder: field.placeholder,
  hint: field.hint,
  revealed: field.kind === "secret" && field.masked === false,
  prefill: field.prefill === "account",
});

export function methodsOf(p: CredentialProviderState): SignInMethod[] {
  const declared = p.signIn?.methods ?? [];
  if (declared.length) return declared.map((m) => ({ id: m.id, title: m.title, kind: m.kind, fields: (m.fields ?? []).map(fieldOf), appURL: m.appURL, appTitle: m.appTitle }));
  if (p.setup?.kind === "desktopIntegration") return [{ id: "app", title: titleOf(p), kind: "desktopApproval", fields: [], appURL: p.setup.appURL }];
  if (p.setup?.kind === "browserSignIn") return [{ id: "browser", title: titleOf(p), kind: "browserApproval", fields: [] }];
  return [];
}

const serverOf = (server: VaultServerSpec): SignInServer => ({
  id: server.id,
  title: server.title,
  url: server.url,
  custom: server.custom ? { title: CUSTOM_SERVER_TITLE, placeholder: server.placeholder } : null,
});

export const serversOf = (p: CredentialProviderState): SignInServer[] => (p.signIn?.servers ?? []).map(serverOf);

export function fieldNamed(p: CredentialProviderState, id: string | undefined): SignInField | null {
  if (!id) return null;
  for (const method of methodsOf(p)) {
    const field = method.fields.find((f) => f.id === id);
    if (field) return field;
  }
  return null;
}

export function unlockFieldOf(p: CredentialProviderState): SignInField | null {
  const field = fieldNamed(p, p.signIn?.unlockField);
  return field?.type === "secret" ? field : null;
}

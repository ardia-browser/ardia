import type { VaultSignInResult } from "../../platform/vaults";

export type SignInField = "server" | "email" | "password" | "clientId" | "clientSecret" | "code" | "token";

export type FieldError = { field: SignInField | null; text: string };

export type SignInStage = "login" | "apiKey" | "code" | "unlock" | "token" | "approval";

export type CodeMethod = { id: string; name: string };

export type CodeStep = { methods: CodeMethod[]; method: string; emailSent: boolean };

const EMAIL_METHOD = "1";

const NONE: FieldError = { field: null, text: "" };

const mentions = (text: string, needles: string[]) => {
  const lower = text.toLowerCase();
  return needles.some((n) => lower.includes(n));
};

export const FAILED_SIGN_IN = "failed";
export const CANCELLED_SIGN_IN = "cancelled";

export const wasCancelled = (result: VaultSignInResult) => !result.ok && result.error === CANCELLED_SIGN_IN;

export function signInMessage(result: VaultSignInResult, name: string): string {
  if (result.ok || wasCancelled(result)) return "";
  if (result.error && result.error !== FAILED_SIGN_IN) return result.error;
  return `${name} didn't respond. Try again.`;
}

export function placeSignInError(result: VaultSignInResult, name: string, stage: SignInStage): FieldError {
  if (result.ok || wasCancelled(result)) return NONE;
  const text = signInMessage(result, name);
  if (mentions(text, ["server", "https address"])) return { field: "server", text };
  if (stage !== "apiKey" && mentions(text, ["api key"])) return { field: null, text };
  if (stage === "code") return { field: "code", text };
  if (stage === "token") return { field: "token", text };
  if (stage === "unlock") return { field: "password", text };
  if (result.needs === "email") return { field: "email", text: result.error ? text : "Enter your email address." };
  if (mentions(text, ["organization keys"])) return { field: "clientId", text };
  if (mentions(text, ["accept that api key"])) return { field: "clientSecret", text };
  if (result.needs === "password" || mentions(text, ["master password"])) return { field: "password", text };
  return { field: null, text };
}

export function codeStepAfter(result: VaultSignInResult, previous: CodeStep | null): CodeStep | null {
  if (result.ok || result.needs !== "code") return previous && !result.ok ? previous : null;
  if (result.methods?.length) {
    const kept = previous && result.methods.some((m) => m.id === previous.method) ? previous.method : result.methods[0]!.id;
    return { methods: result.methods, method: kept, emailSent: false };
  }
  if (!previous) return { methods: [], method: "", emailSent: false };
  return { ...previous, emailSent: previous.method === EMAIL_METHOD };
}

export function chooseCodeMethod(step: CodeStep, method: string): CodeStep {
  return method === step.method ? step : { ...step, method, emailSent: false };
}

export const sendsEmail = (step: CodeStep) => step.method === EMAIL_METHOD && !step.emailSent;

export function codeSubmitTitle(step: CodeStep): string {
  return sendsEmail(step) ? "Send Code" : "Continue";
}

export function canSubmitCode(step: CodeStep, code: string): boolean {
  return sendsEmail(step) || code.trim().length > 0;
}

export function codePrompt(step: CodeStep): string {
  if (step.method === EMAIL_METHOD) return step.emailSent ? "Enter the code Bitwarden emailed you." : "Bitwarden emails you a code.";
  if (step.method === "0") return "Enter the code from your authenticator app.";
  if (step.method === "3") return "Touch your YubiKey.";
  return "Enter your two-step login code.";
}

export function codeError(result: VaultSignInResult, name: string, previous: CodeStep | null): FieldError {
  if (result.ok || wasCancelled(result)) return NONE;
  if (!previous && result.needs === "code") return NONE;
  if (result.needs === "code" && previous && result.methods?.length) return NONE;
  if (result.needs === "code" && previous && previous.method === EMAIL_METHOD && !previous.emailSent) return NONE;
  return placeSignInError(result, name, "code");
}

const IN_PROGRESS = "finish signing in";

export function protonFailure(message: string | null | undefined): string {
  if (!message || message.toLowerCase().startsWith(IN_PROGRESS)) return "";
  return message;
}

export function installCheckError(stillMissing: boolean, name: string): string {
  return stillMissing ? `${name}'s command-line tool still isn't installed.` : "";
}

export type PairingToastAction = { title: string; run(): void };

export function pairingToastActions(appPath: string | null, open: (appPath: string) => void): { action: PairingToastAction; secondary?: PairingToastAction } {
  const dismiss: PairingToastAction = { title: "Dismiss", run: () => {} };
  return appPath ? { action: { title: "Open 1Password", run: () => open(appPath) }, secondary: dismiss } : { action: dismiss };
}

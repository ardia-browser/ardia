type ShellOnWindows = { copyText?(text: string): void } | null;

export const windowsShellClipboard = (native: () => ShellOnWindows) => ({
  copyURL: (address: string) => native()?.copyText?.(address),
});

export const highContrastOn = (): Promise<boolean> => Promise.resolve(false);

export const onHighContrast = (_listener: (on: boolean) => void): (() => void) => () => {};

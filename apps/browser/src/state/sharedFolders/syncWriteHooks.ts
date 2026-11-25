export const syncWriteHooks: { around: (write: () => void) => void } = { around: (write) => write() };

export const foreignWriteHooks: { around: (write: () => void) => void } = { around: (write) => write() };

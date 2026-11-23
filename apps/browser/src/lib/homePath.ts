export const homeRelative = (path: string) => path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");

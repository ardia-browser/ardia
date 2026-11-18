const DEFAULT_SIDE = 16;
const POINTS_PER_SIDE = 0.8;

const sideOf = (side: unknown) => (typeof side === "number" && Number.isFinite(side) ? side : DEFAULT_SIDE);

export const folderSymbolFor = (open: boolean, side: unknown) => ({ name: open ? "folder.fill" : "folder", size: sideOf(side) * POINTS_PER_SIDE });

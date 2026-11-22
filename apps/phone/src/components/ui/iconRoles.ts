import { iconRoleSymbols } from "../../lib/iconRoles";
import type { SymbolName } from "./symbolPaths";

export const iconRoles = iconRoleSymbols satisfies Record<string, SymbolName>;

export type IconRole = keyof typeof iconRoles;

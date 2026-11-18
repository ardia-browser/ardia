import type { ThemeRoles } from "../../lib/themeFile";
import { NO_OUTLINE_ROLES } from "./tokens";

export function withoutOutlines(roles: ThemeRoles | null): ThemeRoles {
  return { dark: { ...roles?.dark, ...NO_OUTLINE_ROLES }, light: { ...roles?.light, ...NO_OUTLINE_ROLES } };
}

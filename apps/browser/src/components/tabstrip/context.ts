import { createContext } from "react";
import type { Strip } from "./model";

export const FloatingStrip = createContext(false);
type StripRef = { readonly current: Strip };
export const DockContext = createContext<StripRef | null>(null);

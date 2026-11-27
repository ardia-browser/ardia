import { createContext } from "react";

export const OutsidePressIgnoreContext = createContext<((event: Event) => boolean) | undefined>(undefined);

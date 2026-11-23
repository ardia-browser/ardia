import type { Plugin } from "vite";
import { credentialWording } from "./credentialWording";
import { linuxWording } from "./linuxWording";
import { calendarWording } from "./calendarWording";
import { syncWording } from "./syncWording";

export const linuxWordingPlugins = (): Plugin[] => [credentialWording(), linuxWording(), calendarWording(), syncWording()];

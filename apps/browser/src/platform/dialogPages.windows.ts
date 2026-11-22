import { requireNativeModule } from "expo-modules-core";
import type { DialogPagesNative } from "@ardia/shell";
import { t } from "../lib/uiLanguage";


export const dialogPages = requireNativeModule<DialogPagesNative>(t(`ArdiaDialogPages`));

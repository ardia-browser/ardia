import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import { keyText } from "../commands/keyText";
import { platformWording } from "./platformWording";

export const copyWords = platformWording(PLATFORM_TERMS, PLATFORM_FEATURES, keyText);

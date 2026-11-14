import { defineModule } from "../bridge";
import { takeCounts } from "../counts";

defineModule("ArdiaLinuxCounts", { sync: { take: () => takeCounts() } });

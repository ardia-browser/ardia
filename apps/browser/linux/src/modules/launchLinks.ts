import { defineModule } from "../bridge";
import { takeOpenedAtLaunch, uiListening } from "../launchLinks";

defineModule("ArdiaLaunchLinks", {
  sync: { takeOpenedAtLaunch, listening: uiListening },
});

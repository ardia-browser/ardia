import { watchRelaunches } from "../../../expo-windows/src/engine/relaunch";
import { installFrameForwarding } from "./frames";
import { installKeyboardFollows } from "./keyboard";
import { installKeys } from "./keys";
import { installSwitchesFetch } from "./killSwitches";
import { openLaunchLinks } from "./launchLinks";
import { startUpdater } from "./updater";

installFrameForwarding();
installKeyboardFollows();
watchRelaunches();
installSwitchesFetch();
installKeys();
openLaunchLinks();
startUpdater();

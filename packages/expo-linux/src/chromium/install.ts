import { watchRelaunches } from "../../../expo-windows/src/engine/relaunch";
import { installFrameForwarding } from "./frames";
import { installKeyboardFollows } from "./keyboard";
import { installKeys } from "./keys";
import { startUpdater } from "./updater";

installFrameForwarding();
installKeyboardFollows();
watchRelaunches();
installKeys();
startUpdater();

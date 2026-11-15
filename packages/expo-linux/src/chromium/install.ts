import { watchRelaunches } from "../../../expo-windows/src/engine/relaunch";
import { installFrameForwarding } from "./frames";
import { installKeyboardFollows } from "./keyboard";

installFrameForwarding();
installKeyboardFollows();
watchRelaunches();

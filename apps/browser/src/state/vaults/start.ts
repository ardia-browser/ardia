import { startVaultContextMenu } from "./contextFill";
import { startCodeAutofill } from "./fill";
import { startGeneratedPasswords } from "./generated";
import { startVaultMenus } from "./menu";
import { startVaultMenuDropdowns } from "./menuDropdown";
import { startChromeDropdownPolicy } from "./dropdownPolicy";
import { startArdiaScope } from "./ardiaScope";
import { startArdiaSources } from "./ardiaSources";
import { startVaultIndex } from "./store";
import { startStandaloneCodes } from "./standaloneCodes";
import { startPasskeys } from "./passkeys";
import { startVaultBackupWatch } from "./sync";
import { startVaultCodeSetup } from "./totpSetup";
import { startVaultWarming } from "./warm";
import { startAutofillMenus } from "../autofill/fieldMenu";
import { vaultsSupported } from "./enabled";

export function startVaults() {
  if (!vaultsSupported) return;
  startVaultIndex();
  startVaultMenus();
  startVaultMenuDropdowns();
  startChromeDropdownPolicy();
  startArdiaScope();
  startArdiaSources();
  startGeneratedPasswords();
  startVaultContextMenu();
  startVaultCodeSetup();
  startCodeAutofill();
  startVaultBackupWatch();
  startVaultWarming();
  startStandaloneCodes();
  startPasskeys();
  startAutofillMenus();
}

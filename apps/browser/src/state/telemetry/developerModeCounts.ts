export type DeveloperBarAction = "siteControls" | "address" | "copyLink" | "console" | "network" | "inspect" | "extensions" | "split";

const BAR_FIELDS: Record<DeveloperBarAction, string> = {
  siteControls: "developer_bar_site_controls",
  address: "developer_bar_address_opens",
  copyLink: "developer_bar_link_copies",
  console: "developer_bar_console_opens",
  network: "developer_bar_network_opens",
  inspect: "developer_bar_inspects",
  extensions: "developer_bar_extension_runs",
  split: "developer_bar_split_menus",
};

let turnedOn = 0;
let turnedOff = 0;
let turnedOffOnLocal = 0;
let barPresses: Record<string, number> = {};

export function noteDeveloperModeToggled(on: boolean, localSite: boolean) {
  if (on) turnedOn++;
  else {
    turnedOff++;
    if (localSite) turnedOffOnLocal++;
  }
}

export function noteDeveloperBarPress(action: DeveloperBarAction) {
  const field = BAR_FIELDS[action];
  barPresses[field] = (barPresses[field] ?? 0) + 1;
}

export function takeDeveloperModeCounts() {
  const taken = {
    developer_mode_turned_on: turnedOn,
    developer_mode_turned_off: turnedOff,
    developer_mode_turned_off_on_local_sites: turnedOffOnLocal,
    ...Object.fromEntries(Object.values(BAR_FIELDS).map((field) => [field, barPresses[field] ?? 0])),
  };
  turnedOn = 0;
  turnedOff = 0;
  turnedOffOnLocal = 0;
  barPresses = {};
  return taken;
}

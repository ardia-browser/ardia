const LIBRARIES = "DYLD_INSERT_LIBRARIES=";
const SWITCHES = "ARDIA_SWITCHES=";

export function sideLaunchEnv(shared, controlOnly, role, instance = []) {
  const side = [...shared, ...(role === "control" ? controlOnly : [])];
  const extra = [...side, ...instance].filter((e) => !e.startsWith(LIBRARIES));
  return {
    extra,
    switches: extra.find((e) => e.startsWith(SWITCHES))?.slice(SWITCHES.length),
    libraries: side.filter((e) => e.startsWith(LIBRARIES)).map((e) => e.slice(LIBRARIES.length)),
  };
}

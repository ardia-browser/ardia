export function exposeDevSync(api: object) {
  (globalThis as { acSync?: object }).acSync = {
    ...api,
    get menu(): typeof import("./menu") {
      return require("./menu");
    },
  };
}

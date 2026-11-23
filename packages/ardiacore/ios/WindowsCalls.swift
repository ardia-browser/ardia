import ExpoModulesCore

func windowsCallTable(list listHandler: @escaping CallHandler, dev devHandler: @escaping CallHandler) -> CallTable {
  CallTable(domain: "windows", handlers: [
    "list": listHandler,
    "dev": devHandler,
  ])
}

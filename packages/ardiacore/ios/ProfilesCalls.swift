import ExpoModulesCore

func profilesCallTable(loaded loadedHandler: @escaping CallHandler, release releaseHandler: @escaping CallHandler, unloadIdle unloadIdleHandler: @escaping CallHandler, deleteData deleteDataHandler: @escaping CallHandler, clearBrowsingData clearBrowsingDataHandler: @escaping CallHandler) -> CallTable {
  CallTable(domain: "profiles", handlers: [
    "loaded": loadedHandler,
    "release": releaseHandler,
    "unloadIdle": unloadIdleHandler,
    "deleteData": deleteDataHandler,
    "clearBrowsingData": clearBrowsingDataHandler,
  ])
}

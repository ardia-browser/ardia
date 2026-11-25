import ExpoModulesCore

public class LocationModule: Module, LocationNative {
  static func locationPermission() -> String { LocationAccess.shared.status() }

  static func requestLocationPermission(_ promise: Promise) { LocationAccess.shared.request { promise.resolve($0) } }

  static func openLocationSettings() { LocationAccess.shared.openSettings() }

  static func devLocationRequests() -> Int { LocationAccess.shared.fakeRequests }

  public func definition() -> ModuleDefinition {
    Name(Self.moduleName)

    Self.locationPermissionFunction
    Self.requestLocationPermissionFunction
    Self.openLocationSettingsFunction
    Self.devLocationRequestsFunction
  }
}

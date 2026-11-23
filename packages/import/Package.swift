// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "ArdiaImportCore",
  platforms: [.macOS(.v14)],
  products: [.library(name: "ArdiaImportCore", targets: ["ArdiaImportCore"])],
  dependencies: [.package(name: "sync", path: "../sync")],
  targets: [
    .target(
      name: "ArdiaImportCore",
      dependencies: [.product(name: "ArdiaCoreRS", package: "sync")],
      path: "ios/Core",
      linkerSettings: [.linkedLibrary("sqlite3")]
    ),
    .testTarget(
      name: "ArdiaImportCoreTests",
      dependencies: ["ArdiaImportCore", .product(name: "ArdiaCoreRS", package: "sync")],
      path: "tests"
    ),
  ]
)

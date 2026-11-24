// swift-tools-version:6.2
import PackageDescription

let package = Package(
  name: "ArdiaTalk",
  platforms: [.iOS("27.0"), .macOS("27.0")],
  products: [
    .library(name: "ArdiaTalk", targets: ["ArdiaTalk"]),
  ],
  dependencies: [
    .package(url: "https://github.com/gradium-ai/xn-ptts.git", exact: "0.7.1"),
  ],
  targets: [
    .target(name: "ArdiaTalk", dependencies: [.product(name: "ptts", package: "xn-ptts")]),
  ]
)

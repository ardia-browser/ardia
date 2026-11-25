import ArdiaBrowser
import Foundation

enum PhoneBlocking {
  static let directory = URL.cachesDirectory.appending(path: "Blocking", directoryHint: .isDirectory)
  static let demoFiltersDirectory = URL.temporaryDirectory.appending(path: "ArdiaDemoFilters", directoryHint: .isDirectory)

  @MainActor
  static func filterLists(isDemo: Bool, defaults: UserDefaults, demoDirectory: URL = demoFiltersDirectory) -> FilterLists? {
    isDemo ? .demo(directory: demoDirectory, defaults: defaults) : nil
  }

  @MainActor
  static func blocker(isDemo: Bool, defaults: UserDefaults, directory: URL = directory, demoDirectory: URL = demoFiltersDirectory, session: URLSession = .shared) -> ContentBlocker {
    ContentBlocker(settings: BlockingSettings(defaults: defaults), directory: directory, session: session, filterLists: filterLists(isDemo: isDemo, defaults: defaults, demoDirectory: demoDirectory))
  }
}

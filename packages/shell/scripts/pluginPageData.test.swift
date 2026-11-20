import AppKit

@main
enum PluginPageDataTest {
  static func main() {
    let app = NSApplication.shared
    DispatchQueue.main.async {
      PluginPageData.remove(UUID()) { error in
        print(error.map { "failed: \($0)" } ?? "removed")
        exit(error == nil ? 0 : 1)
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
      print("no answer in 15 s")
      exit(2)
    }
    app.run()
  }
}

import XCTest

@testable import ArdiaPluginCore

final class PluginLoginPathTests: XCTestCase {
  var home = ""
  var marker: String { "\(home)/Programs/.path-line" }

  override func setUpWithError() throws {
    let made = FileManager.default.temporaryDirectory.appendingPathComponent("login-path-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: made.appendingPathComponent("Programs"), withIntermediateDirectories: true)
    home = made.path
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(atPath: home)
  }

  func write(_ name: String, _ text: String) throws {
    let path = "\(home)/\(name)"
    try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try text.write(toFile: path, atomically: true, encoding: .utf8)
  }

  func read(_ name: String) -> String? { try? String(contentsOfFile: "\(home)/\(name)", encoding: .utf8) }

  func ensure(_ shell: String) -> PluginLoginPath.Outcome? {
    PluginLoginPath.ensure(shellPath: "/bin/\(shell)", home: home, configHome: "\(home)/.config", marker: marker)
  }

  func testZshWithTheLineOnlyInBashrcGetsItsZprofile() throws {
    try write(".bashrc", "export PATH=\"$HOME/.local/bin:$PATH\"\n")
    XCTAssertEqual(ensure("zsh"), .init(shell: "zsh", file: "\(home)/.zprofile", wrote: true))
    XCTAssertEqual(read(".zprofile"), PluginLoginPath.exportLine + "\n")
    XCTAssertEqual(read("Programs/.path-line"), "zsh\n\(home)/.zprofile\n")
  }

  func testBashWithTheLineOnlyInZshrcGetsItsBashProfile() throws {
    try write(".zshrc", "path+=(\"$HOME/.local/bin\")\nexport PATH=\"$HOME/.local/bin:$PATH\"\n")
    XCTAssertEqual(ensure("bash"), .init(shell: "bash", file: "\(home)/.bash_profile", wrote: true))
    XCTAssertEqual(read(".bash_profile"), PluginLoginPath.exportLine + "\n")
  }

  func testAMarkerWhoseLineIsGoneIsRepaired() throws {
    XCTAssertEqual(ensure("zsh")?.wrote, true)
    try write(".zprofile", "alias ll='ls -l'\n")
    XCTAssertEqual(ensure("zsh"), .init(shell: "zsh", file: "\(home)/.zprofile", wrote: true))
    XCTAssertEqual(read(".zprofile"), "alias ll='ls -l'\n" + PluginLoginPath.exportLine + "\n")
  }

  func testAChangedLoginShellIsCoveredAndRecorded() throws {
    XCTAssertEqual(ensure("zsh")?.wrote, true)
    XCTAssertEqual(ensure("bash"), .init(shell: "bash", file: "\(home)/.bash_profile", wrote: true))
    XCTAssertEqual(read("Programs/.path-line"), "bash\n\(home)/.bash_profile\n")
  }

  func testALineAlreadyThereWhereTheShellReadsItIsLeftAlone() throws {
    try write(".zshrc", "export PATH=$HOME/.local/bin:$PATH\n")
    XCTAssertEqual(ensure("zsh"), .init(shell: "zsh", file: "\(home)/.zshrc", wrote: false))
    XCTAssertNil(read(".zprofile"))
    XCTAssertEqual(ensure("zsh")?.wrote, false, "a second link writes nothing")
  }

  func testBashReadsBashrcOnlyWhenItsLoginFileSourcesIt() throws {
    try write(".bashrc", "export PATH=\"$HOME/.local/bin:$PATH\"\n")
    try write(".bash_profile", "[ -f ~/.bashrc ] && . ~/.bashrc\n")
    XCTAssertEqual(ensure("bash"), .init(shell: "bash", file: "\(home)/.bashrc", wrote: false))
    try write(".bash_profile", "# source ~/.bashrc\n")
    XCTAssertEqual(ensure("bash"), .init(shell: "bash", file: "\(home)/.bash_profile", wrote: true))
  }

  func testBashWithOnlyAProfileGetsItRatherThanANewBashProfileThatWouldHideIt() throws {
    try write(".profile", "umask 022\n")
    XCTAssertEqual(ensure("bash"), .init(shell: "bash", file: "\(home)/.profile", wrote: true))
    XCTAssertNil(read(".bash_profile"))
  }

  func testFishGetsItsConfD() throws {
    XCTAssertEqual(ensure("fish"), .init(shell: "fish", file: "\(home)/.config/fish/conf.d/ardia.fish", wrote: true))
    XCTAssertEqual(read(".config/fish/conf.d/ardia.fish"), PluginLoginPath.fishLine + "\n")
    try FileManager.default.removeItem(atPath: "\(home)/.config/fish/conf.d/ardia.fish")
    try write(".config/fish/config.fish", "fish_add_path $HOME/.local/bin\n")
    XCTAssertEqual(ensure("fish")?.wrote, false)
  }

  func testAShellWithAnotherSyntaxIsLeftAlone() throws {
    XCTAssertNil(ensure("tcsh"))
    XCTAssertNil(read("Programs/.path-line"))
  }
}

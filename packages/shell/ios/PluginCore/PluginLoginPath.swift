import Foundation

public enum PluginLoginPath {
  public struct Outcome: Equatable {
    public let shell: String
    public let file: String
    public let wrote: Bool
  }

  public static let exportLine = #"export PATH="$HOME/.local/bin:$PATH""#
  public static let fishLine = "contains -- $HOME/.local/bin $PATH; or set -gx PATH $HOME/.local/bin $PATH"

  static func addsLocalBin(_ text: String) -> Bool {
    text.split(separator: "\n").contains { raw in
      let line = raw.trimmingCharacters(in: .whitespaces)
      return !line.hasPrefix("#") && line.contains(".local/bin") && (line.contains("PATH") || line.contains("fish_add_path"))
    }
  }

  static func sourcesBashrc(_ text: String) -> Bool {
    text.split(separator: "\n").contains { raw in
      let line = raw.trimmingCharacters(in: .whitespaces)
      guard !line.hasPrefix("#"), line.contains(".bashrc") else { return false }
      let words = line.split(whereSeparator: { " \t;&|".contains($0) })
      return words.contains(".") || words.contains("source")
    }
  }

  static func plan(shell: String, home: String, configHome: String, read: (String) -> String?) -> (file: String, line: String, reads: [String])? {
    let at = { (name: String) in (home as NSString).appendingPathComponent(name) }
    switch shell {
    case "zsh":
      return (at(".zprofile"), exportLine, [".zshenv", ".zprofile", ".zshrc", ".zlogin"].map(at))
    case "bash":
      let login = [".bash_profile", ".bash_login", ".profile"].map(at).first { read($0) != nil } ?? at(".bash_profile")
      let reads = [login] + (sourcesBashrc(read(login) ?? "") ? [at(".bashrc")] : [])
      return (login, exportLine, reads)
    case "fish":
      let fish = (configHome as NSString).appendingPathComponent("fish")
      return ((fish as NSString).appendingPathComponent("conf.d/ardia.fish"), fishLine, ["config.fish", "conf.d/ardia.fish"].map { (fish as NSString).appendingPathComponent($0) })
    case "sh", "dash", "ksh", "mksh", "yash":
      return (at(".profile"), exportLine, [at(".profile")])
    default:
      return nil
    }
  }

  public static func ensure(shellPath: String, home: String, configHome: String, marker: String) -> Outcome? {
    let shell = (shellPath as NSString).lastPathComponent
    let read = { (path: String) -> String? in try? String(contentsOfFile: path, encoding: .utf8) }
    guard let plan = plan(shell: shell, home: home, configHome: configHome, read: read) else { return nil }
    let covering = plan.reads.first { addsLocalBin(read($0) ?? "") }
    var wrote = false
    if covering == nil {
      try? FileManager.default.createDirectory(atPath: (plan.file as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
      let existing = read(plan.file) ?? ""
      let text = (existing.isEmpty || existing.hasSuffix("\n") ? "" : "\n") + plan.line + "\n"
      guard let handle = FileHandle(forWritingAtPath: plan.file) ?? (FileManager.default.createFile(atPath: plan.file, contents: nil) ? FileHandle(forWritingAtPath: plan.file) : nil) else { return nil }
      defer { try? handle.close() }
      _ = try? handle.seekToEnd()
      guard (try? handle.write(contentsOf: Data(text.utf8))) != nil else { return nil }
      wrote = true
    }
    let outcome = Outcome(shell: shell, file: covering ?? plan.file, wrote: wrote)
    let record = "\(outcome.shell)\n\(outcome.file)\n"
    if read(marker) != record { try? record.write(toFile: marker, atomically: true, encoding: .utf8) }
    return outcome
  }
}

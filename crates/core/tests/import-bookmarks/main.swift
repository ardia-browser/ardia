import Foundation

let profile = URL(fileURLWithPath: CommandLine.arguments[1])
let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
do {
  let node = try ChromiumBookmarks.load(profile: profile)
  FileHandle.standardOutput.write(Data("{\"ok\":".utf8) + (try encoder.encode(node)) + Data("}".utf8))
} catch let error as ImportError {
  FileHandle.standardOutput.write(Data("{\"error\":\"\(error.code)\"}".utf8))
}

import Foundation

enum VaultSharedSites {
  static let sourcesByPage: [String: [String]] = parse(VaultSharedSitesData.text)

  static func parse(_ text: String) -> [String: [String]] {
    var table: [String: [String]] = [:]
    let offer = { (sources: [String], page: String) in
      for source in sources where source != page && !(table[page]?.contains(source) ?? false) { table[page, default: []].append(source) }
    }
    for entry in text.split(separator: ";") {
      let sides = entry.split(separator: ">", omittingEmptySubsequences: false).map { $0.split(separator: ",").map(String.init) }
      switch sides.count {
      case 1:
        for page in sides[0] { offer(sides[0], page) }
      case 2:
        for page in sides[1] { offer(sides[0], page) }
      default:
        continue
      }
    }
    return table
  }

  static func sources(host: String, site: String) -> [String] {
    var found: [String] = []
    for page in host == site ? [site] : [host, site] {
      for source in sourcesByPage[page] ?? [] where source != host && source != site && !found.contains(source) { found.append(source) }
    }
    return found
  }
}

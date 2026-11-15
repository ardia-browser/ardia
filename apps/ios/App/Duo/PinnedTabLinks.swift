import ArdiaBrowser
import ArdiaSync
import Foundation
import Observation

@MainActor
@Observable
final class PinnedTabLinks {
  private enum Key {
    static let links = "duo.pinnedTabLinks"
    static let hidden = "duo.hiddenPinnedTiles"
  }

  @ObservationIgnored private let defaults: UserDefaults
  private var links: [String: UUID]
  private(set) var hidden: Set<String>

  init(defaults: UserDefaults) {
    self.defaults = defaults
    let stored = defaults.dictionary(forKey: Key.links) as? [String: String] ?? [:]
    links = stored.compactMapValues(UUID.init(uuidString:))
    hidden = Set(defaults.stringArray(forKey: Key.hidden) ?? [])
  }

  static func scopedKey(_ key: String, space: String?) -> String {
    "\(space ?? "")/\(key)"
  }

  func tabID(for key: String) -> UUID? {
    links[key]
  }

  func link(_ key: String, to id: UUID) {
    guard links[key] != id else { return }
    links = links.filter { $0.value != id }
    links[key] = id
    defaults.set(links.mapValues(\.uuidString), forKey: Key.links)
  }

  func hide(_ key: String) {
    hidden.insert(key)
    links[key] = nil
    defaults.set(Array(hidden), forKey: Key.hidden)
    defaults.set(links.mapValues(\.uuidString), forKey: Key.links)
  }
}

extension AppModel {
  var visiblePinnedTiles: [PinnedTile] {
    let space = currentSpace?.syncId
    let hidden = pinnedLinks.hidden
    return (currentSpace?.pinned.tiles ?? []).filter { !hidden.contains(PinnedTabLinks.scopedKey($0.key, space: space)) }
  }

  func linkedPinnedTab(key: String) -> BrowserTab? {
    let scoped = PinnedTabLinks.scopedKey(key, space: currentSpace?.syncId)
    guard let id = pinnedLinks.tabID(for: scoped) else { return nil }
    return tabs.openTabs.first { $0.id == id }
  }

  func openPinnedPage(key: String, url: String, title: String) {
    let scoped = PinnedTabLinks.scopedKey(key, space: currentSpace?.syncId)
    if let tab = linkedPinnedTab(key: key) {
      if isIncognito { isIncognito = false }
      openTab(tab.id)
      return
    }
    if let existing = tabs.openTabs.first(where: { $0.url == url }) {
      pinnedLinks.link(scoped, to: existing.id)
      if isIncognito { isIncognito = false }
      openTab(existing.id)
      return
    }
    openPinned(url: url, title: title)
    if let opened = tabs.selectedTabID { pinnedLinks.link(scoped, to: opened) }
  }

  func returnToPinnedPage(key: String, url: String, title: String) {
    guard let tab = linkedPinnedTab(key: key), let target = URL(string: url) else {
      openPinnedPage(key: key, url: url, title: title)
      return
    }
    openTab(tab.id)
    web.webTab(for: tab.id)?.load(target)
  }

  func unpinFromPhone(key: String) {
    pinnedLinks.hide(PinnedTabLinks.scopedKey(key, space: currentSpace?.syncId))
  }
}

import AppKit
import ArdiaCore

enum MainMenu {
  private static var moveToProfile = NSMenu(title: ShellL10n.t("Move to Profile"))
  private static var moveToWindow = NSMenu(title: ShellL10n.t("Move to Window"))
  static var profiles = NSMenu(title: ShellL10n.t("Profiles"))
  private static var profilesItem = NSMenuItem(title: ShellL10n.t("Profiles"), action: nil, keyEquivalent: "")
  private static var profilesSeparator = NSMenuItem.separator()
  private static var littleArdiaInProfile = NSMenu(title: ShellL10n.t("New Little Ardia Window in Profile"))
  private static var littleArdiaInProfileItem = NSMenuItem(title: ShellL10n.t("New Little Ardia Window in Profile"), action: nil, keyEquivalent: "")
  private static var bookmarks = NSMenu(title: ShellL10n.t("Bookmarks"))
  private static var bookmarksFixedCount = 0
  private static var bookmarkItems: [NSMenuItem] = []
  private static var history = NSMenu(title: ShellL10n.t("History"))
  private static var extensions = NSMenu(title: ShellL10n.t("Extensions"))
  private static var extensionIcons: [String: NSImage] = [:]

  static func performAppWideKey(_ event: NSEvent) -> Bool {
    guard let item = appWideItem(for: event, in: NSApp.mainMenu), MenuTarget.shared.validateMenuItem(item) else { return false }
    if item.action == #selector(MenuTarget.quit(_:)) { MenuTarget.shared.quit(item) } else { KeyRepeatGate.withKeyEquivalent(event) { MenuTarget.shared.performCommand(item) } }
    return true
  }

  private static func appWideItem(for event: NSEvent, in menu: NSMenu?) -> NSMenuItem? {
    for item in menu?.items ?? [] {
      if let found = appWideItem(for: event, in: item.submenu) { return found }
      let appWide = item.action == #selector(MenuTarget.quit(_:)) || (item as? CommandItem)?.command == CommandTable.Command.openSettings.rawValue
      guard appWide, KeyEquivalentMatch.matches(item, event) else { continue }
      return item
    }
    return nil
  }

  static func build() -> NSMenu {
    ArdiaWebView.setAppWideKeys { MainMenu.performAppWideKey($0) }
    let appName = ProcessInfo.processInfo.processName
    let main = KeyEquivalentMenu()
    moveToProfile = NSMenu(title: ShellL10n.t("Move to Profile"))
    moveToWindow = NSMenu(title: ShellL10n.t("Move to Window"))
    profiles = NSMenu(title: ShellL10n.t("Profiles"))
    profilesSeparator = NSMenuItem.separator()
    littleArdiaInProfile = NSMenu(title: ShellL10n.t("New Little Ardia Window in Profile"))

    func std(_ title: String, _ action: Selector) -> StandardItem { StandardItem(title, action) }
    func sub(_ title: String, _ items: [NSMenuItem], menu: NSMenu? = nil) -> NSMenuItem {
      let submenu = menu ?? KeyEquivalentMenu(title: title)
      submenu.autoenablesItems = true
      items.flatMap(withAliases).forEach(submenu.addItem)
      let root = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      root.submenu = submenu
      return root
    }
    func top(_ title: String, _ items: [NSMenuItem], menu: NSMenu? = nil) -> NSMenu {
      let item = sub(title, items, menu: menu)
      main.addItem(item)
      return item.submenu!
    }
    func cmd(_ command: CommandTable.Command, arg: String? = nil, title: String? = nil) -> CommandItem {
      CommandItem(command, arg: arg, title: title)
    }
    func hidden(_ command: CommandTable.Command, arg: String? = nil) -> CommandItem { cmd(command, arg: arg).hiddenShortcut() }

    func bookmarkItem<Item: NSMenuItem>(_ item: Item) -> Item {
      bookmarkItems.append(item)
      return item
    }
    bookmarkItems = []

    let shareMenu = NSMenu(title: ShellL10n.t("Share"))
    shareMenu.delegate = ShareMenu.shared

    let quit = std(ShellL10n.t("Quit {app}", replacing: "app", with: appName), #selector(MenuTarget.quit(_:)))
    quit.target = MenuTarget.shared
    let closeWindow = std(ShellL10n.t("Close Window"), #selector(MenuTarget.closeWindow(_:)))
    closeWindow.target = MenuTarget.shared
    let services = NSMenu(title: ShellL10n.t("Services"))
    NSApp.servicesMenu = services
    _ = top(appName, [
      aboutItem(ShellL10n.t("About {app}", replacing: "app", with: appName)),
      updatesItem(),
      .separator(),
      cmd(.openSettings),
      cmd(.importBrowserData),
      .separator(),
      sub(ShellL10n.t("Services"), [], menu: services),
      .separator(),
      std(ShellL10n.t("Hide {app}", replacing: "app", with: appName), #selector(NSApplication.hide(_:))),
      std(ShellL10n.t("Hide Others"), #selector(NSApplication.hideOtherApplications(_:))),
      std(ShellL10n.t("Show All"), #selector(NSApplication.unhideAllApplications(_:))),
      .separator(),
      quit,
    ])

    littleArdiaInProfileItem = sub(ShellL10n.t("New Little Ardia Window in Profile"), [], menu: littleArdiaInProfile)
    _ = top(ShellL10n.t("File"), [
      cmd(.newTab),
      cmd(.newTabInGroup),
      cmd(.newWindow),
      cmd(.newIncognitoWindow),
      cmd(.newLittleArdia),
      littleArdiaInProfileItem,
      hidden(.toggleOpenLinksInLittleArdia),
      cmd(.reopenClosedTab),
      cmd(.reopenClosedWindow),
      cmd(.openFile),
      .separator(),
      cmd(.focusCommandBar),
      .separator(),
      closeWindow,
      cmd(.closeTab),
      cmd(.closeAllTabs),
      cmd(.cleanUpTabs),
      .separator(),
      cmd(.savePage),
      sub(ShellL10n.t("Share"), [cmd(.share), .separator()], menu: shareMenu),
      hidden(.emailPageLocation),
      cmd(.print),
      cmd(.printWithSystemDialog),
    ])

    let paste = std(ShellL10n.t("Paste and Match Style"), #selector(MenuTarget.pasteAndMatchStyle(_:)))
    paste.target = MenuTarget.shared
    let edits = [
      std(ShellL10n.t("Cut"), #selector(NSText.cut(_:))), std(ShellL10n.t("Copy"), #selector(NSText.copy(_:))),
      std(ShellL10n.t("Paste"), #selector(NSText.paste(_:))), std(ShellL10n.t("Select All"), #selector(NSText.selectAll(_:))),
    ]
    edits.forEach { $0.target = MenuTarget.shared }
    let undo = std(ShellL10n.t("Undo"), MenuTarget.undoAction)
    undo.target = MenuTarget.shared
    let redo = std(ShellL10n.t("Redo"), MenuTarget.redoAction)
    redo.target = MenuTarget.shared
    _ = top(ShellL10n.t("Edit"), [
      undo,
      redo,
      .separator(),
      edits[0],
      edits[1],
      cmd(.copyUrl),
      cmd(.copyUrlAsMarkdown),
      edits[2],
      paste,
      std(ShellL10n.t("Delete"), #selector(NSText.delete(_:))),
      edits[3],
      .separator(),
      sub(ShellL10n.t("Find"), [
        cmd(.findInPage),
        cmd(.findAndReplace),
        cmd(.findNext),
        cmd(.findPrevious),
        cmd(.useSelectionForFind),
        cmd(.jumpToSelection),
      ]),
      sub(ShellL10n.t("Spelling and Grammar"), [
        std(ShellL10n.t("Show Spelling and Grammar"), #selector(NSText.showGuessPanel(_:))),
        std(ShellL10n.t("Check Document Now"), #selector(NSText.checkSpelling(_:))),
        .separator(),
        std(ShellL10n.t("Check Spelling While Typing"), #selector(NSTextView.toggleContinuousSpellChecking(_:))),
        std(ShellL10n.t("Check Grammar With Spelling"), #selector(NSTextView.toggleGrammarChecking(_:))),
        std(ShellL10n.t("Correct Spelling Automatically"), #selector(NSTextView.toggleAutomaticSpellingCorrection(_:))),
      ]),
      sub(ShellL10n.t("Substitutions"), [
        std(ShellL10n.t("Show Substitutions"), #selector(NSTextView.orderFrontSubstitutionsPanel(_:))),
        .separator(),
        std(ShellL10n.t("Smart Copy/Paste"), #selector(NSTextView.toggleSmartInsertDelete(_:))),
        std(ShellL10n.t("Smart Quotes"), #selector(NSTextView.toggleAutomaticQuoteSubstitution(_:))),
        std(ShellL10n.t("Smart Dashes"), #selector(NSTextView.toggleAutomaticDashSubstitution(_:))),
        std(ShellL10n.t("Smart Links"), #selector(NSTextView.toggleAutomaticLinkDetection(_:))),
        std(ShellL10n.t("Data Detectors"), #selector(NSTextView.toggleAutomaticDataDetection(_:))),
        std(ShellL10n.t("Text Replacement"), #selector(NSTextView.toggleAutomaticTextReplacement(_:))),
      ]),
      sub(ShellL10n.t("Transformations"), [
        std(ShellL10n.t("Make Upper Case"), #selector(NSResponder.uppercaseWord(_:))),
        std(ShellL10n.t("Make Lower Case"), #selector(NSResponder.lowercaseWord(_:))),
        std(ShellL10n.t("Capitalize"), #selector(NSResponder.capitalizeWord(_:))),
      ]),
      sub(ShellL10n.t("Speech"), [
        std(ShellL10n.t("Start Speaking"), #selector(NSTextView.startSpeaking(_:))),
        std(ShellL10n.t("Stop Speaking"), #selector(NSTextView.stopSpeaking(_:))),
      ]),
      sub(ShellL10n.t("AutoFill"), [
        cmd(.autofill, arg: "contact"),
        cmd(.autofill, arg: "passwords"),
        cmd(.autofill, arg: "creditCard"),
      ]),
    ])

    _ = top(ShellL10n.t("View"), [
      sub(ShellL10n.t("Appearance"), [
        cmd(.setAppearance, arg: "auto"),
        cmd(.setAppearance, arg: "light"),
        cmd(.setAppearance, arg: "dark"),
      ]),
      cmd(.stop),
      cmd(.reload),
      cmd(.forceReload).alternate(),
      .separator(),
      sub(ShellL10n.t("Browser Layout"), [
        cmd(.setTabLayout, arg: "sidebarLeft"),
        cmd(.setTabLayout, arg: "sidebarRight"),
        cmd(.setTabLayout, arg: "top"),
        hidden(.toggleTabLayout),
        .separator(),
        cmd(.toggleAddressBar),
        cmd(.toggleCompactToolbar),
        cmd(.toggleFullUrl),
        .separator(),
        cmd(.toggleSidebar),
        cmd(.toggleMinimalism),
        bookmarkItem(sub(ShellL10n.t("Show Bookmarks Bar"), [
          cmd(.setBookmarksBar, arg: "always"),
          cmd(.setBookmarksBar, arg: "newTab"),
          cmd(.setBookmarksBar, arg: "never"),
          .separator(),
          cmd(.toggleBookmarksBar),
        ])),
        cmd(.togglePinnedFold).hiddenWhenDisabled(),
      ]),
      sub(ShellL10n.t("Split View"), [
        cmd(.openSplitPane),
        cmd(.openSplitPaneBelow),
        cmd(.focusNextPane),
        cmd(.focusPreviousPane),
        cmd(.moveSplitPaneLeft),
        cmd(.moveSplitPaneRight),
        cmd(.moveSplitPaneUp),
        cmd(.moveSplitPaneDown),
      ]),
      .separator(),
      cmd(.cast),
      cmd(.togglePageEngine),
      cmd(.toggleReader),
      .separator(),
      cmd(.zoomReset),
      cmd(.zoomIn),
      cmd(.zoomOut),
      .separator(),
      sub(ShellL10n.t("Hide Elements"), [
        cmd(.hideElement),
        cmd(.showHiddenElements),
      ]),
      .separator(),
      std(ShellL10n.t("Enter Full Screen"), #selector(NSWindow.toggleFullScreen(_:))),
      .separator(),
      sub(ShellL10n.t("Developer"), [
        cmd(.viewSource),
        cmd(.devTools),
        cmd(.inspectElements),
        cmd(.javaScriptConsole),
        cmd(.toggleJavaScriptFromAppleEvents),
        hidden(.toggleDevTools),
        hidden(.caretBrowsing),
      ]),
    ])

    _ = top(ShellL10n.t("Tabs"), [
      cmd(.back),
      cmd(.forward),
      .separator(),
      cmd(.nextTab),
      cmd(.previousTab),
      hidden(.moveTabDown),
      hidden(.moveTabUp),
      cmd(.searchTabs),
      hidden(.tabSwitcher, arg: "forward"),
      hidden(.tabSwitcher, arg: "backward"),
      hidden(.returnToPinnedUrl),
    ] + (1...8).map { hidden(.selectTab, arg: "\($0)") } + [
      hidden(.selectLastTab),
      .separator(),
      cmd(.togglePin),
      cmd(.togglePin, arg: "tile").hiddenWhenDisabled(),
      cmd(.togglePinnedRow),
      cmd(.duplicateTab),
      cmd(.newGroupWithTabs),
      hidden(.closeTabGroup),
      .separator(),
      sub(ShellL10n.t("Move to Profile"), [], menu: moveToProfile),
      sub(ShellL10n.t("Move to Window"), [], menu: moveToWindow),
      bookmarkItem(NSMenuItem.separator()),
      bookmarkItem(cmd(.bookmarkPage)),
      .separator(),
      cmd(.renameTab),
      cmd(.changeTabIcon),
      cmd(.toggleMute),
    ])

    bookmarks = top(ShellL10n.t("Bookmarks"), [
      cmd(.bookmarkPage, title: ShellL10n.t("Bookmark This Page")),
      cmd(.bookmarkAllTabs),
      cmd(.manageBookmarks),
      cmd(.exportBookmarks),
    ])
    bookmarksFixedCount = bookmarks.items.count
    if let bookmarksRoot = main.items.first(where: { $0.submenu === bookmarks }) { bookmarkItems.append(bookmarksRoot) }
    history = top(ShellL10n.t("History"), [])
    extensions = top(ShellL10n.t("Extensions"), [])

    profilesItem = sub(ShellL10n.t("Profiles"), [], menu: profiles)
    let minimizeAll = std(ShellL10n.t("Minimize All"), #selector(NSApplication.miniaturizeAll(_:)))
    let arrange = std(ShellL10n.t("Arrange in Front"), #selector(MenuTarget.arrangeWindowsInFront(_:)))
    arrange.target = MenuTarget.shared
    let keepOnTop = std(ShellL10n.t("Keep Window on Top"), #selector(MenuTarget.toggleKeepOnTop(_:)))
    keepOnTop.target = MenuTarget.shared
    minimizeAll.isAlternate = true
    let windowMenu = top(ShellL10n.t("Window"), [
      std(ShellL10n.t("Minimize"), #selector(NSWindow.performMiniaturize(_:))),
      minimizeAll,
      std(ShellL10n.t("Zoom"), #selector(NSWindow.performZoom(_:))),
      arrange,
      keepOnTop,
      .separator(),
      cmd(.downloads),
      cmd(.taskManager),
      cmd(.mergeAllWindows),
      profilesSeparator,
      profilesItem,
      hidden(.openProfileMenu),
    ])
    let helpMenu = top(ShellL10n.t("Help"), helpItems())
    MenuCatalog.capture(
      main, dynamic: [services, shareMenu, moveToProfile, moveToWindow, profiles, littleArdiaInProfile, history, extensions],
      growing: [bookmarks, windowMenu])
    NSApp.windowsMenu = windowMenu
    NSApp.helpMenu = helpMenu

    built = nil
    refresh()
    return main
  }

  private static func withAliases(_ item: NSMenuItem) -> [NSMenuItem] {
    switch item {
    case let item as CommandItem: [item] + item.aliasItems()
    case let item as StandardItem: [item] + item.aliasItems()
    default: [item]
    }
  }

  static func keyEquivalent(_ key: String, _ mods: NSEvent.ModifierFlags) -> (key: String, mods: NSEvent.ModifierFlags) {
    guard mods.contains(.shift), key.count == 1, let scalar = key.unicodeScalars.first, ("a"..."z").contains(scalar) else {
      return (key, mods)
    }
    return (key.uppercased(), mods.subtracting(.shift))
  }

  private static func aboutItem(_ title: String) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: #selector(AppUpdater.showAbout(_:)), keyEquivalent: "")
    item.target = AppUpdater.shared
    return item
  }

  private static func updatesItem() -> NSMenuItem {
    let item = NSMenuItem(title: ShellL10n.t("Check for Updates…"), action: #selector(AppUpdater.checkForUpdates(_:)), keyEquivalent: "")
    item.target = AppUpdater.shared
    return item
  }

  private static func videoTourItem() -> NSMenuItem {
    let item = CommandItem(.videoTour)
    let url = Bundle.main.object(forInfoDictionaryKey: "ACVideoTourURL") as? String ?? ""
    item.isHidden = URL(string: url)?.scheme?.hasPrefix("http") != true
    return item
  }

  private static func releaseNotesItem() -> NSMenuItem {
    let item = CommandItem(.releaseNotes)
    let url = Bundle.main.object(forInfoDictionaryKey: "ACReleaseNotesURL") as? String ?? ""
    item.isHidden = URL(string: url)?.scheme?.hasPrefix("http") != true
    return item
  }

  private static func helpItems() -> [NSMenuItem] {
    var items: [NSMenuItem] = [
      CommandItem(.reportProblem),
      CommandItem(.keyboardShortcuts),
      CommandItem(.toolTour),
      videoTourItem(),
      releaseNotesItem(),
      .separator(),
      CommandItem(.copyDiagnostics),
      CommandItem(.copyLastFreeze),
    ]
    #if DEBUG
    items += [.separator(), CommandItem(.showOnboarding)]
    #endif
    return items
  }

  private static func extensionIcon(_ dataURL: String?) -> NSImage? {
    guard let dataURL else { return nil }
    if let cached = extensionIcons[dataURL] { return cached }
    guard let image = NSImage(dataURL: dataURL) else { return nil }
    image.size = NSSize(width: 16, height: 16)
    extensionIcons[dataURL] = image
    return image
  }

  private static var built: (profiles: [MenuEntry], windows: [MenuEntry], bookmarks: Int?,
                             extensions: [String], history: [[MenuEntry]])?

  static func refresh() {
    let state = MenuState.current
    let last = built
    let extensionKeys = state.extensions.map { "\($0.id)|\($0.title)|\($0.icon ?? "")" }
    let history = [state.recentlyClosed, state.recentlyClosedGroups]
    built = (state.profiles, state.windows, state.bookmarksRevision, extensionKeys, history)
    if last?.profiles != state.profiles { buildProfileMenus(state) }
    if last?.windows != state.windows { buildMoveToWindow(state) }
    if state.bookmarksRevision == nil || last?.bookmarks != state.bookmarksRevision { buildBookmarkMenus(state) }
    if last?.extensions != extensionKeys { buildExtensions(state) }
    if last?.history != history { buildHistory(state) }
    for item in bookmarkItems where item.isHidden == state.bookmarksShown { item.isHidden = !state.bookmarksShown }
    applyShortcuts(state.shortcuts)
  }

  private static func emptyItem() -> NSMenuItem {
    let item = NSMenuItem(title: ShellL10n.t("Empty"), action: nil, keyEquivalent: "")
    item.isEnabled = false
    return item
  }

  private static func folderItem(_ title: String, _ children: [MenuBookmark], id: String? = nil, holdsArcHolders: Bool = false, arcHolder: Bool = false) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    let menu = NSMenu(title: title)
    addBookmarks(children, to: menu, holdsArcHolders: holdsArcHolders)
    if children.isEmpty { menu.addItem(emptyItem()) }
    if let id, hasGroupLinks(children) {
      menu.addItem(.separator())
      menu.addItem(CommandItem(ShellL10n.t("Add to Sidebar as Group"), "addFolderToSidebar", arg: id))
      if arcHolder && children.contains(where: { $0.children.map(hasGroupLinks) ?? false }) {
        menu.addItem(CommandItem(ShellL10n.t("Restore Arc Folders as Groups"), "restoreArcFolders", arg: id))
      }
    }
    item.submenu = menu
    item.image = NSImage(systemSymbolName: "folder", accessibilityDescription: nil)
    return item
  }

  private static func hasGroupLinks(_ nodes: [MenuBookmark]) -> Bool {
    nodes.contains { node in
      if let children = node.children { return hasGroupLinks(children) }
      let url = (node.url ?? "").lowercased()
      return url.hasPrefix("http:") || url.hasPrefix("https:") || url.hasPrefix("file:")
    }
  }

  private static func addBookmarks(_ nodes: [MenuBookmark], to menu: NSMenu, holdsArcHolders: Bool = false) {
    for node in nodes {
      if let children = node.children {
        menu.addItem(folderItem(node.title, children, id: node.id, arcHolder: holdsArcHolders && node.title.hasSuffix(" (Arc)")))
      } else {
        menu.addItem(CommandItem(node.title.isEmpty ? (node.url ?? "") : node.title, "openBookmark", arg: node.id))
      }
    }
  }

  static func dockMenu() -> NSMenu {
    let menu = NSMenu()
    let state = MenuState.current
    if state.profiles.count == 2 {
      for p in state.profiles {
        let item = CommandItem(ShellL10n.t("New {profile} Window", replacing: "profile", with: p.title), "newWindow", arg: p.id)
        item.windowless = true
        menu.addItem(item)
      }
    } else {
      let item = CommandItem(ShellL10n.t("New Window"), "newWindow")
      item.windowless = true
      menu.addItem(item)
    }
    if state.profiles.count > 2 {
      let inProfile = NSMenu(title: ShellL10n.t("New Window in Profile"))
      for p in state.profiles {
        let item = CommandItem(p.title, "newWindow", arg: p.id)
        item.windowless = true
        inProfile.addItem(item)
      }
      let root = NSMenuItem(title: inProfile.title, action: nil, keyEquivalent: "")
      root.submenu = inProfile
      menu.addItem(root)
    }
    let incognito = CommandItem(ShellL10n.t("New Incognito Window"), "newIncognitoWindow")
    incognito.windowless = true
    menu.addItem(incognito)
    let small = CommandItem(ShellL10n.t("New Little Ardia Window"), "newLittleArdia")
    small.windowless = true
    menu.addItem(small)
    if state.profiles.count > 1 {
      let inProfile = NSMenu(title: ShellL10n.t("New Little Ardia Window in Profile"))
      for p in state.profiles {
        let item = CommandItem(p.title, "newLittleArdia", arg: p.id)
        item.windowless = true
        inProfile.addItem(item)
      }
      let root = NSMenuItem(title: inProfile.title, action: nil, keyEquivalent: "")
      root.submenu = inProfile
      menu.addItem(root)
    }
    return menu
  }

  private static func buildProfileMenus(_ state: MenuState) {
    moveToProfile.removeAllItems()
    for p in state.profiles {
      let item = CommandItem(p.title, "moveTabToProfile", arg: p.id)
      item.tracksChecked = false
      item.state = p.current ? .on : .off
      moveToProfile.addItem(item)
    }

    profiles.removeAllItems()
    profilesItem.isHidden = state.profiles.count < 2
    profilesSeparator.isHidden = profilesItem.isHidden
    for p in state.profiles {
      let item = CommandItem(p.title, "switchProfile", arg: p.id)
      item.tracksChecked = false
      item.state = p.current ? .on : .off
      profiles.addItem(item)
      let newWindow = CommandItem("\(p.title) ↗", "newWindow", arg: p.id, key: "", []).commandAlternate(of: item)
      newWindow.tracksChecked = false
      profiles.addItem(newWindow)
    }
    profiles.addItem(.separator())
    profiles.addItem(CommandItem(.nextProfile))
    profiles.addItem(CommandItem(.previousProfile))
    profiles.addItem(.separator())
    profiles.addItem(CommandItem(.newProfile))

    littleArdiaInProfile.removeAllItems()
    littleArdiaInProfileItem.isHidden = state.profiles.count < 2
    for p in state.profiles { littleArdiaInProfile.addItem(CommandItem(p.title, "newLittleArdia", arg: p.id)) }
  }

  private static func buildMoveToWindow(_ state: MenuState) {
    moveToWindow.removeAllItems()
    for w in state.windows { moveToWindow.addItem(CommandItem(w.title, "moveTabToWindow", arg: w.id)) }
    if !state.windows.isEmpty { moveToWindow.addItem(.separator()) }
    moveToWindow.addItem(CommandItem(ShellL10n.t("New Window"), "moveTabToWindow", arg: "new"))
  }

  private static func buildBookmarkMenus(_ state: MenuState) {
    while bookmarks.items.count > bookmarksFixedCount { bookmarks.removeItem(at: bookmarksFixedCount) }
    bookmarks.addItem(.separator())
    if !state.bookmarks.recentBookmarks.isEmpty {
      let header = NSMenuItem(title: ShellL10n.t("Recent Bookmarks"), action: nil, keyEquivalent: "")
      header.isEnabled = false
      bookmarks.addItem(header)
      addBookmarks(state.bookmarks.recentBookmarks, to: bookmarks)
      bookmarks.addItem(.separator())
    }
    bookmarks.addItem(folderItem(ShellL10n.t("Bookmarks Bar"), state.bookmarks.bookmarksBar, holdsArcHolders: true))
    bookmarks.addItem(folderItem(ShellL10n.t("Other Bookmarks"), state.bookmarks.otherBookmarks))
  }

  private static func buildExtensions(_ state: MenuState) {
    extensions.removeAllItems()
    for ext in state.extensions {
      let item = CommandItem(ext.title, "openExtension", arg: ext.id)
      item.image = extensionIcon(ext.icon)
      extensions.addItem(item)
    }
    if !state.extensions.isEmpty { extensions.addItem(.separator()) }
    extensions.addItem(CommandItem(.manageExtensions))
    extensions.addItem(CommandItem(.addExtension))
    extensions.addItem(CommandItem(.pinExtensions).hiddenShortcut())
  }

  private static func buildHistory(_ state: MenuState) {
    history.removeAllItems()
    history.addItem(CommandItem(.showHistory))
    history.addItem(CommandItem(.clearBrowsingData))
    history.addItem(.separator())
    let header = NSMenuItem(title: ShellL10n.t("Recently Closed"), action: nil, keyEquivalent: "")
    header.isEnabled = false
    history.addItem(header)
    for entry in state.recentlyClosed { history.addItem(CommandItem(entry.title, "restoreClosed", arg: entry.id)) }
    if state.recentlyClosed.isEmpty { history.addItem(emptyItem()) }
    if !state.recentlyClosedGroups.isEmpty {
      history.addItem(.separator())
      let groupsHeader = NSMenuItem(title: ShellL10n.t("Recently Closed Groups"), action: nil, keyEquivalent: "")
      groupsHeader.isEnabled = false
      history.addItem(groupsHeader)
      for entry in state.recentlyClosedGroups { history.addItem(CommandItem(entry.title, "restoreClosed", arg: entry.id)) }
    }
    history.addItem(.separator())
    history.addItem(CommandItem(.clearRecentlyClosed))
  }
}

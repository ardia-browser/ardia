import AppKit
import ArdiaCore
import ExpoModulesCore
import OSAKit

enum AppleNotesScripting {
  static let queue = DispatchQueue(label: "ardia.apple-notes")
  static let notDelivered = -1743
  static let backgroundRefusal = -1

  static let foldersSource = """
  (() => {
    const app = Application("com.apple.Notes");
    const out = [];
    const walk = (folder, account, parent, depth) => {
      if (depth > 32) return;
      let id = "", name = "", count = 0;
      try { id = folder.id(); name = folder.name(); count = folder.notes.length; } catch (e) { return; }
      out.push({ id, name, account, parent, count });
      let children = [];
      try { children = folder.folders(); } catch (e) {}
      for (const child of children) walk(child, account, id, depth + 1);
    };
    for (const account of app.accounts()) {
      let accountName = "";
      try { accountName = account.name(); } catch (e) {}
      let folders = [];
      try { folders = account.folders(); } catch (e) {}
      const nested = new Set();
      for (const f of folders) { try { for (const c of f.folders()) nested.add(c.id()); } catch (e) {} }
      for (const f of folders) { try { if (!nested.has(f.id())) walk(f, accountName, "", 0); } catch (e) {} }
    }
    return JSON.stringify(out);
  })()
  """

  static func notesSource(folder: String, offset: Int, limit: Int) -> String? {
    guard let data = try? JSONSerialization.data(withJSONObject: [folder], options: [.fragmentsAllowed]),
          let literal = String(data: data, encoding: .utf8) else { return nil }
    return """
    (() => {
      const app = Application("com.apple.Notes");
      const folder = app.folders.byId(\(literal)[0]);
      const notes = folder.notes;
      const total = notes.length;
      const ids = notes.id();
      const out = [];
      const end = Math.min(total, \(max(0, offset)) + \(max(0, min(limit, 200))));
      for (let i = \(max(0, offset)); i < end; i++) {
        const id = ids[i];
        const note = app.notes.byId(id);
        try { if (note.id() !== id) continue; } catch (e) { continue; }
        let locked = true;
        try { locked = note.passwordProtected() !== false; } catch (e) { locked = true; }
        const entry = { id, name: "", created: 0, modified: 0, locked, body: "" };
        try { entry.name = note.name(); entry.created = +note.creationDate(); entry.modified = +note.modificationDate(); } catch (e) {}
        if (!locked) { try { entry.body = note.body(); } catch (e) { entry.body = ""; } }
        out.push(entry);
      }
      return JSON.stringify({ total, notes: out });
    })()
    """
  }

  static func run(_ source: String, _ promise: Promise) {
    if LaunchConfig.shared.background {
      promise.resolve(["ok": false, "error": "A background test instance never asks Notes for your notes.", "code": backgroundRefusal])
      return
    }
    queue.async {
      guard let language = OSALanguage(forName: "JavaScript") else {
        promise.resolve(["ok": false, "error": "JavaScript for Automation isn't available on this Mac.", "code": 0])
        return
      }
      let script = OSAScript(source: source, language: language)
      var error: NSDictionary?
      let result = script.executeAndReturnError(&error)
      if let error {
        let code = (error[OSAScriptErrorNumberKey] as? Int) ?? (error[NSAppleScript.errorNumber] as? Int) ?? 0
        let message = (error[OSAScriptErrorMessageKey] as? String) ?? (error[NSAppleScript.errorMessage] as? String) ?? "Notes didn't answer."
        promise.resolve(["ok": false, "error": message, "code": code])
        return
      }
      promise.resolve(["ok": true, "json": result?.stringValue ?? ""])
    }
  }
}

extension SystemModule {
  static func appleNotesFolders(_ promise: Promise) {
    AppleNotesScripting.run(AppleNotesScripting.foldersSource, promise)
  }

  static func appleNotesNotes(_ folder: String, _ offset: Int, _ limit: Int, _ promise: Promise) {
    guard !folder.isEmpty, folder.utf8.count <= 512, let source = AppleNotesScripting.notesSource(folder: folder, offset: offset, limit: limit) else {
      promise.resolve(["ok": false, "error": "That isn't a Notes folder.", "code": 0])
      return
    }
    AppleNotesScripting.run(source, promise)
  }
}

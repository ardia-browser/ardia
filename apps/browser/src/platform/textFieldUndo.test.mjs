import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PATCH = new URL("../../../../patches/react-native-macos@0.81.9.patch", import.meta.url);
const patch = readFileSync(PATCH, "utf8");
const clang = process.platform === "darwin" && spawnSync("xcrun", ["--find", "clang"]).status === 0;

function patchedFile(path) {
  const start = patch.indexOf(`diff --git a/${path} b/${path}`);
  assert.notEqual(start, -1, `the patch no longer changes ${path}`);
  const next = patch.indexOf("\ndiff --git ", start + 1);
  return patch
    .slice(start, next === -1 ? undefined : next)
    .split("\n")
    .filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || line.startsWith(" "))
    .map((line) => line.slice(1))
    .join("\n");
}

const textField = patchedFile("Libraries/Text/TextInput/Singleline/RCTUITextField.mm");

function slice(source, from, to, what) {
  const start = source.indexOf(from);
  assert.notEqual(start, -1, `${what} is missing from the patched RCTUITextField.mm`);
  const end = source.indexOf(to, start);
  assert.notEqual(end, -1, `${what} lost its end`);
  return source.slice(start, end + to.length);
}

const textDidChange = () => `- (void)_textDidChange\n${slice(textField, "{\n  _textWasPasted = NO;", "\n}\n", "_textDidChange")}`;
const restyle = () => slice(textField, "- (BOOL)ardia_restyleEditorKeepingUndo:", "\n}\n", "ardia_restyleEditorKeepingUndo:");
const plainPasteEditor = () => {
  const start = textField.indexOf("static NSString *RCTUISingleLinePastedText(NSString *text)");
  assert.notEqual(start, -1, "the patch no longer defines RCTUISingleLinePastedText");
  const implementation = textField.indexOf("@implementation RCTUIPlainPasteFieldEditor", start);
  assert.notEqual(implementation, -1, "the patch no longer implements RCTUIPlainPasteFieldEditor");
  return textField.slice(start, implementation) + slice(textField.slice(implementation), "@implementation RCTUIPlainPasteFieldEditor", "\n@end\n", "RCTUIPlainPasteFieldEditor");
};
const fieldEditorForView = () => slice(textField, "- (NSTextView *)fieldEditorForView:(NSView *)controlView", "} // Ardia]", "fieldEditorForView:").replace(/\} \/\/ Ardia\]$/, "}");

test("a single-line field's own change handler restyles its text without emptying the editor's undo", () => {
  const body = textDidChange();
  assert.match(body, /ardia_restyleEditorKeepingUndo:/, "_textDidChange writes the text back through the cell on every keystroke, which empties the field editor's undo (#2284)");
  assert.match(restyle(), /hasMarkedText/, "an input method's marked text must still take the old path");
});

const FIELD_CLASSES = `
@interface HarnessCell : NSTextFieldCell
@property (nonatomic, copy) NSArray<NSPasteboardType> *pasteTypes;
@end

@implementation HarnessCell {
  RCTUIPlainPasteFieldEditor *_plainPasteEditor;
}
FIELD_EDITOR_FOR_VIEW
@end

@interface RCTUITextField : NSTextField
@property (nonatomic, copy) NSDictionary<NSAttributedStringKey, id> *defaultTextAttributes;
@end

@implementation RCTUITextField {
  BOOL _textWasPasted;
}
+ (Class)cellClass { return HarnessCell.class; }
- (instancetype)initWithFrame:(NSRect)frame
{
  if (self = [super initWithFrame:frame]) {
    self.allowsEditingTextAttributes = YES;
    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(_textDidChange) name:NSControlTextDidChangeNotification object:self];
  }
  return self;
}
- (void)setAttributedText:(NSAttributedString *)attributedText { self.attributedStringValue = attributedText; }
- (NSString *)text { return self.stringValue; }
TEXT_DID_CHANGE
RESTYLE
@end
`;

const fieldSource = () =>
  "#import <AppKit/AppKit.h>\n\n" +
  plainPasteEditor() +
  FIELD_CLASSES.replace("FIELD_EDITOR_FOR_VIEW", fieldEditorForView()).replace("TEXT_DID_CHANGE", textDidChange()).replace("RESTYLE", restyle());

const OBJC_MAIN = `
static NSMutableDictionary *out;
static id flag(BOOL value) { return value ? @YES : @NO; }
static NSWindow *window;

static void type(NSTextView *editor, NSString *text)
{
  for (NSUInteger i = 0; i < text.length; i++) {
    [editor insertText:[text substringWithRange:NSMakeRange(i, 1)] replacementRange:NSMakeRange(NSNotFound, 0)];
  }
}

static NSDictionary *run(NSArray<NSPasteboardType> *pasteTypes)
{
  NSMutableDictionary *got = [NSMutableDictionary new];
  RCTUITextField *field = [[RCTUITextField alloc] initWithFrame:NSMakeRect(0, 0, 200, 22)];
  NSDictionary *attributes = @{ NSFontAttributeName : [NSFont systemFontOfSize:13], NSForegroundColorAttributeName : NSColor.systemPinkColor };
  field.defaultTextAttributes = attributes;
  ((HarnessCell *)field.cell).pasteTypes = pasteTypes;
  [window.contentView addSubview:field];
  [window makeFirstResponder:field];
  NSTextView *editor = (NSTextView *)field.currentEditor;
  editor.typingAttributes = @{ NSFontAttributeName : [NSFont systemFontOfSize:20], NSForegroundColorAttributeName : NSColor.systemGreenColor };
  type(editor, @"sidebar");
  got[@"editorClass"] = NSStringFromClass(editor.class);
  got[@"typed"] = [editor.string copy];
  got[@"restyled"] = flag([[editor.textStorage attributesAtIndex:0 effectiveRange:NULL][NSForegroundColorAttributeName] isEqual:NSColor.systemPinkColor]);
  got[@"canUndo"] = flag(editor.undoManager.canUndo);
  if (editor.undoManager.canUndo) [editor.undoManager undo];
  got[@"afterUndo"] = [editor.string copy];
  got[@"canRedo"] = flag(editor.undoManager.canRedo);
  if (editor.undoManager.canRedo) [editor.undoManager redo];
  got[@"afterRedo"] = [editor.string copy];
  [field setAttributedText:[[NSAttributedString alloc] initWithString:@"from js" attributes:attributes]];
  got[@"canUndoAfterOutsideText"] = flag(editor.undoManager.canUndo);
  [window makeFirstResponder:nil];
  [field removeFromSuperview];
  return got;
}

int main(void)
{
  @autoreleasepool {
    [NSApplication sharedApplication];
    out = [NSMutableDictionary new];
    window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 300, 200) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:YES];
    window.releasedWhenClosed = NO;
    out[@"shared"] = run(nil);
    out[@"plainPaste"] = run(@[ NSPasteboardTypeString ]);
    NSData *json = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
    printf("%s\\n", [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String);
  }
  return 0;
}
`;

test("typing in a single-line field can be undone and redone in AppKit's shared field editor and in the command bar's own", { skip: !clang && "needs clang" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "text-field-undo-"));
  try {
    writeFileSync(join(dir, "main.m"), fieldSource() + OBJC_MAIN);
    execFileSync("xcrun", ["clang", "-fobjc-arc", "-Wno-objc-method-access", "-framework", "AppKit", join(dir, "main.m"), "-o", join(dir, "run")], { stdio: "pipe" });
    const got = JSON.parse(execFileSync(join(dir, "run"), { encoding: "utf8", timeout: 30_000 }).trim());
    assert.notEqual(got.shared.editorClass, "RCTUIPlainPasteFieldEditor");
    assert.equal(got.plainPaste.editorClass, "RCTUIPlainPasteFieldEditor");
    for (const editor of ["shared", "plainPaste"]) {
      const run = got[editor];
      assert.equal(run.typed, "sidebar", editor);
      assert.equal(run.restyled, true, `${editor}: typed text keeps the field's own attributes`);
      assert.equal(run.canUndo, true, `${editor}: Edit › Undo is disabled after typing (#2284)`);
      assert.equal(run.afterUndo, "", editor);
      assert.equal(run.canRedo, true, `${editor}: Redo is disabled after an undo`);
      assert.equal(run.afterRedo, "sidebar", editor);
      assert.equal(run.canUndoAfterOutsideText, false, `${editor}: text set from JS must empty the typing undo, whose ranges no longer fit`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const INLINE_KEEP = fileURLToPath(new URL("../../../../packages/shell/ios/InlineKeepCore/InlineKeep.swift", import.meta.url));

const BRIDGE = `#import <AppKit/AppKit.h>
@interface RCTUITextField : NSTextField
@property (nonatomic, copy) NSDictionary<NSAttributedStringKey, id> *defaultTextAttributes;
- (void)setAttributedText:(NSAttributedString *)attributedText;
@end
@interface HarnessCell : NSTextFieldCell
@property (nonatomic, copy) NSArray<NSPasteboardType> *pasteTypes;
@end
`;

const SUGGESTION_DRIVER = `
import AppKit

_ = NSApplication.shared
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 200), styleMask: [.titled], backing: .buffered, defer: true)
window.isReleasedWhenClosed = false
InlineKeep.install()
InlineKeep.fields.insert(7)
var out: [String: [String: Any]] = [:]

func scenario(_ name: String, _ steps: (NSTextView, (String) -> Void) -> Void) {
  let field = RCTUITextField(frame: NSRect(x: 0, y: 0, width: 280, height: 22))
  field.defaultTextAttributes = [.font: NSFont.systemFont(ofSize: 13)]
  (field.cell as! HarnessCell).pasteTypes = [.string]
  window.contentView!.addSubview(field)
  window.makeFirstResponder(field)
  let editor = field.currentEditor() as! NSTextView
  var changes = 0
  let observer = NotificationCenter.default.addObserver(forName: NSControl.textDidChangeNotification, object: field, queue: nil) { _ in changes += 1 }
  var got: [String: Any] = [:]
  steps(editor) { got[$0] = editor.string }
  got["changes"] = changes
  NotificationCenter.default.removeObserver(observer)
  window.makeFirstResponder(nil)
  field.removeFromSuperview()
  out[name] = got
}

func type(_ editor: NSTextView, _ text: String) {
  for c in text { editor.insertText(String(c), replacementRange: NSRange(location: NSNotFound, length: 0)) }
}

func undoAll(_ editor: NSTextView, _ note: (String) -> Void) {
  InlineKeep.settle(editor)
  editor.undoManager?.undo()
  note("undo")
  InlineKeep.settle(editor)
  editor.undoManager?.redo()
  note("redo")
}

func suggest(_ editor: NSTextView, _ typed: String, _ completion: String) {
  _ = InlineKeep.complete(editor, tag: 7, typed: typed, completion: completion)
}

scenario("shown") { editor, note in
  type(editor, "sidebar")
  suggest(editor, "sidebar", ".example.com")
  note("suggested")
  undoAll(editor, note)
}
scenario("typedOver") { editor, note in
  type(editor, "sidebar")
  suggest(editor, "sidebar", ".example.com")
  type(editor, "x")
  note("typed")
  undoAll(editor, note)
}
scenario("keptThenTyped") { editor, note in
  type(editor, "sidebar")
  suggest(editor, "sidebar", ".example.com")
  type(editor, ".ex")
  note("kept")
  type(editor, "q")
  note("typed")
  undoAll(editor, note)
}
scenario("deleted") { editor, note in
  type(editor, "sidebar")
  suggest(editor, "sidebar", ".example.com")
  type(editor, ".ex")
  editor.deleteBackward(nil)
  note("deleted")
  undoAll(editor, note)
}
scenario("wordDeleted") { editor, note in
  type(editor, "exa")
  suggest(editor, "exa", "mple.com")
  editor.deleteWordBackward(nil)
  note("deleted")
  undoAll(editor, note)
}
scenario("lineDeleted") { editor, note in
  type(editor, "exa")
  suggest(editor, "exa", "mple.com")
  editor.deleteToEndOfLine(nil)
  note("deleted")
  undoAll(editor, note)
}
scenario("composed") { editor, note in
  type(editor, "exa")
  suggest(editor, "exa", "mple.com")
  editor.setMarkedText("へんかん", selectedRange: NSRange(location: 4, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
  note("marked")
  editor.insertText("変換", replacementRange: NSRange(location: NSNotFound, length: 0))
  note("committed")
  undoAll(editor, note)
}
scenario("replacedWithinTyping") { editor, note in
  type(editor, "g")
  suggest(editor, "g", "oogle")
  editor.insertText("G", replacementRange: NSRange(location: 0, length: 1))
  note("replaced")
  undoAll(editor, note)
}
func undoToEmpty(_ editor: NSTextView, _ note: (String) -> Void) {
  var steps = 0
  while editor.undoManager?.canUndo == true && steps < 8 {
    InlineKeep.settle(editor)
    editor.undoManager?.undo()
    steps += 1
  }
  note("undone")
  while editor.undoManager?.canRedo == true && steps > 0 {
    InlineKeep.settle(editor)
    editor.undoManager?.redo()
    steps -= 1
  }
  note("redone")
}
scenario("replacedIntoSuggestion") { editor, note in
  type(editor, "g")
  suggest(editor, "g", "oogle")
  editor.breakUndoCoalescing()
  editor.insertText("x", replacementRange: NSRange(location: 1, length: 3))
  note("replaced")
  undoToEmpty(editor, note)
}
scenario("composedIntoSuggestion") { editor, note in
  type(editor, "g")
  suggest(editor, "g", "oogle")
  editor.breakUndoCoalescing()
  editor.setMarkedText("x", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: 1, length: 3))
  editor.insertText("x", replacementRange: NSRange(location: NSNotFound, length: 0))
  note("replaced")
  undoToEmpty(editor, note)
}
scenario("composedWithoutSuggestion") { editor, note in
  type(editor, "ab")
  editor.setMarkedText("か", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
  note(editor.undoManager?.canUndo == true ? "undoableWhileMarked" : "historyLostWhileMarked")
  editor.insertText("家", replacementRange: NSRange(location: NSNotFound, length: 0))
  note("committed")
}
scenario("accepted") { editor, note in
  type(editor, "sidebar")
  suggest(editor, "sidebar", ".example.com")
  editor.setSelectedRange(NSRange(location: (editor.string as NSString).length, length: 0))
  type(editor, "/a")
  note("typed")
  undoAll(editor, note)
}

let json = try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
print(String(data: json, encoding: .utf8)!)
`;

test("the command bar's inline suggestion stays out of Undo and Redo: ⌘Z undoes your typing, ⇧⌘Z gives it back without the suggestion", { skip: !clang && "needs clang" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "inline-suggestion-undo-"));
  try {
    writeFileSync(join(dir, "fields.m"), fieldSource());
    writeFileSync(join(dir, "bridge.h"), BRIDGE);
    writeFileSync(join(dir, "main.swift"), SUGGESTION_DRIVER);
    execFileSync("xcrun", ["clang", "-fobjc-arc", "-Wno-objc-method-access", "-c", join(dir, "fields.m"), "-o", join(dir, "fields.o")], { stdio: "pipe" });
    execFileSync("xcrun", ["swiftc", "-import-objc-header", join(dir, "bridge.h"), join(dir, "main.swift"), INLINE_KEEP, join(dir, "fields.o"), "-o", join(dir, "run")], { stdio: "pipe" });
    const got = JSON.parse(execFileSync(join(dir, "run"), { encoding: "utf8", timeout: 30_000 }).trim());
    assert.deepEqual(got.shown, { suggested: "sidebar.example.com", undo: "", redo: "sidebar", changes: 9 }, "Undo with a suggestion shown removed only the suggestion, or Redo brought it back as typed text");
    assert.deepEqual(got.typedOver, { typed: "sidebarx", undo: "", redo: "sidebarx", changes: 9 }, "typing over a suggestion recorded the suggestion in the undo history");
    assert.deepEqual(got.keptThenTyped, { kept: "sidebar.example.com", typed: "sidebar.exq", undo: "", redo: "sidebar.exq", changes: 9 }, "letters typed ahead into a suggestion were left out of Undo and Redo");
    assert.deepEqual(got.deleted, { deleted: "sidebar.ex", undo: "", redo: "sidebar.ex", changes: 9 }, "deleting a suggestion recorded it in the undo history");
    assert.deepEqual(got.wordDeleted, { deleted: "exa", undo: "", redo: "exa", changes: 5 }, "⌥⌫ on a suggestion put it in the undo history, so ⌘Z brought back the suggestion alone");
    assert.deepEqual(got.lineDeleted, { deleted: "exa", undo: "", redo: "exa", changes: 5 }, "deleting to the end of the line put the suggestion in the undo history");
    assert.deepEqual(got.composed, { marked: "exaへんかん", committed: "exa変換", undo: "", redo: "exa変換", changes: 6 }, "an input method's composition replaced the suggestion inside the undo history");
    assert.deepEqual(got.replacedWithinTyping, { replaced: "G", undo: "", redo: "G", changes: 4 }, "an input method's explicit replacement range inside the typing was moved by taking the suggestion out");
    for (const name of ["replacedIntoSuggestion", "composedIntoSuggestion"]) {
      const run = got[name];
      assert.equal(run.replaced, "gxle", `${name}: a replacement range reaching into the suggestion must replace what it named, not land past the end of a field shortened by taking the suggestion out`);
      assert.equal(run.undone, "", `${name}: Undo left suggestion text behind that no Undo can remove`);
      assert.equal(run.redone, "gxle", name);
    }
    assert.equal(got.composedWithoutSuggestion.undoableWhileMarked, "abか", "composing with an input method emptied the typing undo");
    assert.equal(got.composedWithoutSuggestion.committed, "ab家");
    assert.equal(got.accepted.typed, "sidebar.example.com/a");
    assert.equal(got.accepted.undo, "");
    assert.equal(got.accepted.redo, "sidebar.example.com/a", "an accepted suggestion is part of what Redo gives back");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

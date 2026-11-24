import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const patch = readFileSync(new URL("../../../../patches/react-native-macos@0.81.9.patch", import.meta.url), "utf8");
const added = patch
  .split("\n")
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
  .map((line) => line.slice(1))
  .join("\n");

const clang = process.platform === "darwin" && spawnSync("xcrun", ["--find", "clang"]).status === 0;

function fieldEditorForView() {
  const start = added.indexOf("- (NSTextView *)fieldEditorForView:(NSView *)controlView");
  assert.notEqual(start, -1, "the patch no longer overrides fieldEditorForView:");
  const end = added.indexOf("} // Ardia]", start);
  assert.notEqual(end, -1, "fieldEditorForView: lost its closing Ardia marker");
  return added.slice(start, end);
}

test("the command bar's own field editor records undo, like AppKit's shared field editor", () => {
  const body = fieldEditorForView();
  assert.match(body, /\[\[RCTUIPlainPasteFieldEditor alloc\] initWithFrame:NSZeroRect\]/);
  assert.match(body, /_plainPasteEditor\.allowsUndo = YES;/, "the field editor is built without allowsUndo, so Edit › Undo and Redo are disabled while the bar has focus");
});

test("allowsUndo is set where the field editor is made, before it is handed to AppKit", () => {
  const body = fieldEditorForView();
  const made = body.indexOf("initWithFrame:NSZeroRect");
  const undo = body.indexOf("allowsUndo = YES");
  const returned = body.indexOf("return _plainPasteEditor;");
  assert.ok(made !== -1 && undo > made && returned > undo);
});

function plainPasteEditorSource() {
  const start = added.indexOf("static NSString *RCTUISingleLinePastedText(NSString *text)");
  assert.notEqual(start, -1, "the patch no longer defines RCTUISingleLinePastedText");
  const implementation = added.indexOf("@implementation RCTUIPlainPasteFieldEditor", start);
  assert.notEqual(implementation, -1, "the patch no longer implements RCTUIPlainPasteFieldEditor");
  const end = added.indexOf("\n@end\n", implementation);
  assert.notEqual(end, -1, "RCTUIPlainPasteFieldEditor lost its @end");
  return added.slice(start, end + "\n@end\n".length);
}

const UNDO_HARNESS = `
@interface HarnessCell : NSTextFieldCell
@property (nonatomic, copy) NSArray<NSPasteboardType> *pasteTypes;
@end

@implementation HarnessCell {
  RCTUIPlainPasteFieldEditor *_plainPasteEditor;
}
FIELD_EDITOR_FOR_VIEW
}
@end

@interface HarnessField : NSTextField
@end

@implementation HarnessField
+ (Class)cellClass { return HarnessCell.class; }
@end

static NSMutableDictionary *out;
static id flag(BOOL value) { return value ? @YES : @NO; }
static NSWindow *window;

static HarnessField *focusedField(NSString *typed)
{
  HarnessField *field = [[HarnessField alloc] initWithFrame:NSMakeRect(0, 0, 200, 22)];
  ((HarnessCell *)field.cell).pasteTypes = @[ NSPasteboardTypeString ];
  [window.contentView addSubview:field];
  [window makeFirstResponder:field];
  NSTextView *editor = (NSTextView *)field.currentEditor;
  [editor insertText:typed replacementRange:NSMakeRange(NSNotFound, 0)];
  [editor breakUndoCoalescing];
  return field;
}

static void attempt(NSString *name, void (^body)(void))
{
  @try {
    body();
    out[name] = @"ok";
  } @catch (NSException *exception) {
    out[name] = exception.name;
  }
}

int main(void)
{
  @autoreleasepool {
    [NSApplication sharedApplication];
    out = [NSMutableDictionary new];
    window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 300, 200) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:YES];
    window.releasedWhenClosed = NO;
    NSUndoManager *windowUndo = window.undoManager;

    @autoreleasepool {
      HarnessField *field = focusedField(@"ardia");
      NSTextView *editor = (NSTextView *)field.currentEditor;
      out[@"editorClass"] = NSStringFromClass(editor.class);
      out[@"editorUndoIsWindowUndo"] = flag(editor.undoManager == windowUndo);
      out[@"canUndoWhileEditing"] = flag(editor.undoManager.canUndo);
      [editor.undoManager undo];
      out[@"afterUndo"] = [editor.string copy];
      [editor.undoManager redo];
      out[@"afterRedo"] = [editor.string copy];
      [window makeFirstResponder:nil];
      out[@"windowCanUndoAfterEditing"] = flag(windowUndo.canUndo);
      out[@"editorUndoAfterEditing"] = flag(editor.undoManager != nil);
      field.stringValue = @"";
      [window makeFirstResponder:field];
      out[@"canUndoAfterRefocus"] = flag(editor.undoManager.canUndo || windowUndo.canUndo);
      attempt(@"undoAfterRefocus", ^{
        if (windowUndo.canUndo) [windowUndo undo];
        if (editor.undoManager.canUndo) [editor.undoManager undo];
      });
      [window makeFirstResponder:nil];
      [field removeFromSuperview];
    }

    @autoreleasepool {
      @autoreleasepool {
        HarnessField *field = focusedField(@"gone");
        [window makeFirstResponder:nil];
        [field removeFromSuperview];
      }
      out[@"windowCanUndoAfterFieldFreed"] = flag(windowUndo.canUndo);
      attempt(@"undoAfterFieldFreed", ^{
        if (windowUndo.canUndo) [windowUndo undo];
      });
    }

    NSData *json = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
    printf("%s\\n", [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String);
  }
  return 0;
}
`;

test("the command bar's field editor keeps its undo to its own editing session, so ⌘Z never reaches a closed field's text", { skip: !clang && "needs clang" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "command-bar-field-editor-"));
  try {
    const source = "#import <AppKit/AppKit.h>\n\n" + plainPasteEditorSource() + UNDO_HARNESS.replace("FIELD_EDITOR_FOR_VIEW", fieldEditorForView());
    writeFileSync(join(dir, "main.m"), source);
    execFileSync("xcrun", ["clang", "-fobjc-arc", "-framework", "AppKit", join(dir, "main.m"), "-o", join(dir, "run")], { stdio: "pipe" });
    const got = JSON.parse(execFileSync(join(dir, "run"), { encoding: "utf8", timeout: 30_000 }).trim());
    assert.equal(got.editorClass, "RCTUIPlainPasteFieldEditor");
    assert.equal(got.editorUndoIsWindowUndo, false, "typing undo goes to the window's undo manager, which outlives the field");
    assert.equal(got.canUndoWhileEditing, true, "⌘Z works while the field is being edited");
    assert.equal(got.afterUndo, "");
    assert.equal(got.afterRedo, "ardia");
    assert.equal(got.windowCanUndoAfterEditing, false, "the editing session's typing is left on the window's undo manager");
    assert.equal(got.editorUndoAfterEditing, false, "an editor out of its window still offers an undo manager");
    assert.equal(got.canUndoAfterRefocus, false, "a new editing session can undo the last one's typing over text that has since changed");
    assert.equal(got.undoAfterRefocus, "ok", "undoing the last session's typing threw");
    assert.equal(got.windowCanUndoAfterFieldFreed, false, "a freed field's typing is left on the window's undo manager");
    assert.equal(got.undoAfterFieldFreed, "ok", "⌘Z after the field was gone threw");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

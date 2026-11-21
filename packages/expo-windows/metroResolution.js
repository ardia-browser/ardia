const fs = require("node:fs");
const path = require("node:path");

const backedView = path.resolve(__dirname, "src/views/BackedView.tsx");
const rawView = path.resolve(__dirname, "src/views/raw/rawView.ts");
const reactNativeWindowsView = /[/\\]react-native-windows[/\\]Libraries[/\\]Components[/\\]View[/\\]View\.windows\.js$/;

const realPath = (file) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
};

function backedOnWindows(resolution, originModulePath) {
  if (resolution.type !== "sourceFile" || !reactNativeWindowsView.test(resolution.filePath)) return resolution;
  if (realPath(originModulePath) === realPath(rawView)) return resolution;
  return { type: "sourceFile", filePath: backedView };
}

module.exports = { backedOnWindows, backedView, rawView };

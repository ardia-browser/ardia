const path = require("node:path");
const reanimatedResolver = require("react-native-reanimated/jest/resolver");

const phoneRoot = path.resolve(__dirname, "../..");
const insidePhone = (dir) => dir === phoneRoot || dir.startsWith(phoneRoot + path.sep);
const isBare = (request) => !request.startsWith(".") && !path.isAbsolute(request);

module.exports = (request, options) => reanimatedResolver(request, isBare(request) && !insidePhone(options.basedir) ? { ...options, basedir: phoneRoot } : options);

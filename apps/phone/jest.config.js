const shared = {
  rootDir: __dirname,
  testMatch: ["<rootDir>/src/**/*.render.test.tsx"],
  setupFiles: ["<rootDir>/test/render/setup.ts"],
  resolver: "<rootDir>/test/render/resolver.js",
  transformIgnorePatterns: [
    "node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|react-native-.*|@ardia/.*|zustand))",
  ],
};

module.exports = {
  projects: [
    { ...shared, displayName: "ios", preset: "jest-expo/ios" },
    { ...shared, displayName: "android", preset: "jest-expo/android" },
  ],
};

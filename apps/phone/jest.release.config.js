const base = require("./jest.config.js");

const release = (project) => {
  const preset = require(`jest-expo/${project.displayName}/jest-preset.js`);
  const testTransform = preset.transform["\\.[jt]sx?$"];
  return {
    ...project,
    displayName: `${project.displayName} release`,
    globals: { __DEV__: false },
    transform: {
      "node_modules/(react-native|react-native-gesture-handler)/.+\\.[jt]sx?$": testTransform,
      ...Object.fromEntries(Object.entries(preset.transform).filter(([pattern]) => pattern !== "\\.[jt]sx?$")),
      "\\.[jt]sx?$": ["<rootDir>/test/render/releaseTransform.js", { platform: project.displayName }],
    },
  };
};

module.exports = { projects: base.projects.map(release) };

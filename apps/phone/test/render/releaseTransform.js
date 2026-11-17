const babelJest = require("babel-jest").default ?? require("babel-jest");

module.exports = {
  createTransformer: ({ platform }) =>
    babelJest.createTransformer({
      envName: "production",
      caller: { name: "metro", bundler: "metro", platform, isDev: false, isServer: false, engine: "hermes", supportsStaticESM: false },
    }),
};

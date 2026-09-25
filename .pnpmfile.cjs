// VoltAgent 2.x runs on AI SDK 6 (its peer range) while every other test runs on AI SDK 7, so its
// tests get their own copy of AI SDK 6. Only this repository's install reads this file.
module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === "@voltagent/core" && pkg.peerDependencies && pkg.peerDependencies.ai) {
        delete pkg.peerDependencies.ai;
        pkg.dependencies = { ...pkg.dependencies, ai: "6.0.291" };
      }
      return pkg;
    },
  },
};

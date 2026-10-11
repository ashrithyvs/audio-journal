const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const defaults = getDefaultConfig(__dirname);

// The node companion is a separate deployable with its own node_modules
// (ADR-018); the app bundle never resolves anything from it.
const companion = new RegExp(
  `^${path
    .join(__dirname, 'node-companion')
    .replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\/.*`,
);

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  resolver: {
    blockList: [].concat(defaults.resolver.blockList ?? [], companion),
  },
};

module.exports = mergeConfig(defaults, config);

'use strict';

// @gmft/landlock-shim
// Re-exports the N-API native binding built by binding.gyp.
// Build once before requiring: `pnpm -F @gmft/landlock-shim build`.

module.exports = require('./build/Release/landlock.node');

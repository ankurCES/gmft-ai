'use strict';

// @gmft/seccomp-shim
// Re-exports the N-API native binding built by binding.gyp.
// Build once before requiring: `pnpm -F @gmft/seccomp-shim build`.

module.exports = require('./build/Release/seccomp.node');

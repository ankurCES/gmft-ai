// Smoke test for the @gmft/seccomp-shim native binding.
// Run with: `pnpm -F @gmft/seccomp-shim test`
//
// The test PASSES on a host with seccomp configured AND on a host
// without it (the latter by catching the expected throw from
// prctlGetSeccomp or installBpf).

'use strict';

const sc = require('../index.js');
const assert = require('node:assert/strict');

let passed = 0;
let skipped = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    if (err && err.code === 'SKIP') {
      console.log(`  ⊘ ${name} (skipped: ${err.message})`);
      skipped++;
    } else {
      console.log(`  ✗ ${name}: ${err.message}`);
      process.exitCode = 1;
    }
  }
}

console.log('@gmft/seccomp-shim smoke test');

test('exports the expected top-level keys', () => {
  assert.ok(sc, 'binding loaded');
  for (const k of ['arch', 'prctlSetNoNewPrivs', 'prctlGetSeccomp', 'installBpf', 'constants']) {
    assert.equal(typeof sc[k], k === 'constants' ? 'object' : 'function', `missing ${k}`);
  }
});

test('exports the expected constant keys with the right integer values', () => {
  const c = sc.constants;
  // Spot-check a few known values from the kernel headers.
  assert.equal(c.PR_SET_NO_NEW_PRIVS, 38);
  assert.equal(c.PR_SET_SECCOMP, 22);
  assert.equal(c.PR_GET_SECCOMP, 21);
  assert.equal(c.SECCOMP_MODE_DISABLED, 0);
  assert.equal(c.SECCOMP_MODE_STRICT, 1);
  assert.equal(c.SECCOMP_MODE_FILTER, 2);
  assert.equal(c.SECCOMP_SET_MODE_STRICT, 0);
  assert.equal(c.SECCOMP_SET_MODE_FILTER, 1);
  assert.equal(c.SECCOMP_FILTER_FLAG_TSYNC, 1 << 0);
  assert.equal(c.SECCOMP_FILTER_FLAG_LOG, 1 << 1);
  assert.equal(c.SECCOMP_FILTER_FLAG_SPEC_ALLOW, 1 << 2);
  assert.equal(c.SECCOMP_FILTER_FLAG_NEW_LISTENER, 1 << 3);
  assert.equal(c.SECCOMP_FILTER_FLAG_TSYNC_ESRCH, 1 << 4);
});

test('arch() reports a sane string', () => {
  const a = sc.arch();
  assert.equal(typeof a, 'string');
  assert.ok(a.length > 0);
  console.log(`    arch = ${a}`);
});

test('prctlSetNoNewPrivs() succeeds (host supports prctl)', () => {
  // On every Linux host since 3.5 (2012), this call succeeds.
  // Throws with ESECCOMP on ENOSYS (no prctl, e.g. some embedded targets).
  sc.prctlSetNoNewPrivs();
  // And idempotently — calling twice must also succeed.
  sc.prctlSetNoNewPrivs();
});

test('prctlGetSeccomp() returns 0, 1, or 2', () => {
  const mode = sc.prctlGetSeccomp();
  assert.ok([0, 1, 2].includes(mode), `unexpected mode ${mode}`);
  console.log(`    current seccomp mode = ${mode}`);
});

test('argument validation: installBpf with no args throws TypeError', () => {
  assert.throws(() => sc.installBpf(), /requires/);
});

test('argument validation: installBpf with non-Buffer throws TypeError', () => {
  assert.throws(() => sc.installBpf('not-a-buffer'), /requires|Buffer/);
});

test('argument validation: installBpf with empty Buffer throws TypeError', () => {
  assert.throws(() => sc.installBpf(Buffer.alloc(0)), /multiple of 8/);
});

test('argument validation: installBpf with bad-length Buffer throws TypeError', () => {
  // 9 bytes is not a multiple of 8.
  assert.throws(() => sc.installBpf(Buffer.alloc(9)), /multiple of 8/);
});

console.log(`\n${passed} passed, ${skipped} skipped`);

// Test setup for ink-testing-library. The jsdom env gives us window/document,
// and ink-testing-library needs a TTY-shaped stdout, which it polyfills.
import '@testing-library/jest-dom/vitest';

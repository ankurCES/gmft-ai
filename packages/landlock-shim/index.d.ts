// Type definitions for @gmft/landlock-shim.
// Hand-written — there are no upstream @types for the original mscdex/landlock
// package, and the surface is small enough to be self-describing.

export interface LandlockConstants {
  // Filesystem access bitmasks (BigInt — each is a power of 2).
  LANDLOCK_ACCESS_FS_EXECUTE: bigint;
  LANDLOCK_ACCESS_FS_WRITE_FILE: bigint;
  LANDLOCK_ACCESS_FS_READ_FILE: bigint;
  LANDLOCK_ACCESS_FS_READ_DIR: bigint;
  LANDLOCK_ACCESS_FS_REMOVE_DIR: bigint;
  LANDLOCK_ACCESS_FS_REMOVE_FILE: bigint;
  LANDLOCK_ACCESS_FS_MAKE_CHAR: bigint;
  LANDLOCK_ACCESS_FS_MAKE_DIR: bigint;
  LANDLOCK_ACCESS_FS_MAKE_REG: bigint;
  LANDLOCK_ACCESS_FS_MAKE_SOCK: bigint;
  LANDLOCK_ACCESS_FS_MAKE_FIFO: bigint;
  LANDLOCK_ACCESS_FS_MAKE_BLOCK: bigint;
  LANDLOCK_ACCESS_FS_MAKE_SYM: bigint;
  LANDLOCK_ACCESS_FS_REFER: bigint;
  LANDLOCK_ACCESS_FS_TRUNCATE: bigint;
  LANDLOCK_ACCESS_FS_IOCTL: bigint;

  // Network access bitmasks.
  LANDLOCK_ACCESS_NET_BIND_TCP: bigint;
  LANDLOCK_ACCESS_NET_CONNECT_TCP: bigint;

  // Scope flags.
  LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET: bigint;
  LANDLOCK_SCOPE_SIGNAL: bigint;

  // restrictSelf() flags.
  LANDLOCK_RESTRICT_SELF_LOG_SAME_EXEC_OFF: bigint;
  LANDLOCK_RESTRICT_SELF_LOG_NEW_EXEC_ON: bigint;
  LANDLOCK_RESTRICT_SELF_LOG_SUBDOMAINS_OFF: bigint;

  // Rule type enum (kernel-assigned, starting at 1).
  LANDLOCK_RULE_PATH_BENEATH: bigint; // 1n
  LANDLOCK_RULE_NET_PORT: bigint; // 2n
}

/**
 * The landlock binding. Throws on every method if the kernel does not
 * support landlock; call `getABI()` first and treat a non-1..7 return
 * as "kernel too old."
 */
export interface Landlock {
  readonly constants: LandlockConstants;

  /**
   * Returns the highest landlock ABI the running kernel supports (1..7),
   * or throws if the kernel has no landlock configured.
   */
  getABI(): number;

  /**
   * Returns the kernel's landlock errata bitmask (BigInt). Throws if
   * the kernel has no landlock.
   */
  getErrata(): bigint;

  /**
   * Create a new ruleset. Returns an fd (number) that must be passed to
   * addRule × N, then restrictSelf, then close.
   */
  createRuleset(
    handledAccessFs: bigint | number,
    handledAccessNet?: bigint | number,
    scoped?: bigint | number,
  ): number;

  /**
   * Add a rule to an open ruleset. For PATH_BENEATH, the parent is a path
   * string or an existing fd; for NET_PORT, the parent is a port number
   * 0..65535.
   */
  addRule(
    fd: number,
    ruleType: bigint | number,
    allowedAccess: bigint | number,
    parent: string | number,
  ): void;

  /** Apply the ruleset to the calling thread. IRREVERSIBLE. */
  restrictSelf(fd: number, flags?: bigint | number): void;

  /** Set PR_SET_NO_NEW_PRIVS — required before restrictSelf. */
  setNoNewPrivs(): void;

  /** Close a ruleset fd. */
  close(fd: number): void;
}

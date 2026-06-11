// @gmft/landlock-shim — N-API binding to Linux's landlock LSM.
//
// Forked from mscdex/landlock@0.0.1 (MIT, single-maintainer, Nan-based).
// Reimplemented against node-addon-api so the binding loads cleanly on
// Node 18+ through Node 26+. The C ABI is identical to the original
// (syscall numbers 444/445/446, same struct layouts).
//
// Public API surface (JS):
//   const ll = require('@gmft/landlock-shim');
//   ll.constants.LANDLOCK_ACCESS_FS_WRITE_FILE  // BigInt
//   ll.constants.LANDLOCK_RULE_PATH_BENEATH     // BigInt
//   ll.getABI()                                  // number in [1,7] or throws
//   ll.getErrata()                               // BigInt
//   ll.createRuleset(fsAccess, [netAccess], [scoped])   // number (fd)
//   ll.addRule(fd, ruleType, allowedAccess, parent)      // parent: string | fd
//   ll.restrictSelf(fd, [flags])
//   ll.setNoNewPrivs()
//   ll.close(fd)
//
// Differences from upstream:
//   - No Nan dependency. N-API only.
//   - No `prebuild` script (we build from source on install via node-gyp).
//   - We do NOT cap addRule's parent argument shape — string OR int fd —
//     matching upstream's behavior.

#include <napi.h>

#include <cerrno>
#include <cstring>
#include <string>

#include <fcntl.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef __linux__
#  error "This addon only supports Linux"
#endif

// ---------------------------------------------------------------------------
// kernel.h — syscall shims + struct/constant definitions.
// Mirrors mscdex/landlock v0.0.1's src/kernel.h byte-for-byte so behavior
// matches upstream.
// ---------------------------------------------------------------------------

#ifndef __NR_landlock_create_ruleset
#  if defined(__x86_64__) || defined(__i386__) || defined(__s390__) || \
      defined(__s390x__) || defined(__aarch64__) || defined(__arm__) || \
      defined(__powerpc__) || defined(__riscv)
#    define __NR_landlock_create_ruleset 444
#  elif defined(__mips64__)
#    define __NR_landlock_create_ruleset 5444
#  elif defined(__mips__)
#    define __NR_landlock_create_ruleset 4444
#  else
#    error "Unsupported architecture"
#  endif
#endif

#ifndef __NR_landlock_add_rule
#  if defined(__x86_64__) || defined(__i386__) || defined(__s390__) || \
      defined(__s390x__) || defined(__aarch64__) || defined(__arm__) || \
      defined(__powerpc__) || defined(__riscv)
#    define __NR_landlock_add_rule 445
#  elif defined(__mips64__)
#    define __NR_landlock_add_rule 5445
#  elif defined(__mips__)
#    define __NR_landlock_add_rule 4445
#  else
#    error "Unsupported architecture"
#  endif
#endif

#ifndef __NR_landlock_restrict_self
#  if defined(__x86_64__) || defined(__i386__) || defined(__s390__) || \
      defined(__s390x__) || defined(__aarch64__) || defined(__arm__) || \
      defined(__powerpc__) || defined(__riscv)
#    define __NR_landlock_restrict_self 446
#  elif defined(__mips64__)
#    define __NR_landlock_restrict_self 5446
#  elif defined(__mips__)
#    define __NR_landlock_restrict_self 4446
#  else
#    error "Unsupported architecture"
#  endif
#endif

#ifndef LANDLOCK_CREATE_RULESET_VERSION
#  define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
#endif
#ifndef LANDLOCK_CREATE_RULESET_ERRATA
#  define LANDLOCK_CREATE_RULESET_ERRATA (1U << 1)
#endif

// FS access bitmasks. Each is a power of 2; the caller OR's them.
#ifndef LANDLOCK_ACCESS_FS_EXECUTE
#  define LANDLOCK_ACCESS_FS_EXECUTE (1ULL << 0)
#endif
#ifndef LANDLOCK_ACCESS_FS_WRITE_FILE
#  define LANDLOCK_ACCESS_FS_WRITE_FILE (1ULL << 1)
#endif
#ifndef LANDLOCK_ACCESS_FS_READ_FILE
#  define LANDLOCK_ACCESS_FS_READ_FILE (1ULL << 2)
#endif
#ifndef LANDLOCK_ACCESS_FS_READ_DIR
#  define LANDLOCK_ACCESS_FS_READ_DIR (1ULL << 3)
#endif
#ifndef LANDLOCK_ACCESS_FS_REMOVE_DIR
#  define LANDLOCK_ACCESS_FS_REMOVE_DIR (1ULL << 4)
#endif
#ifndef LANDLOCK_ACCESS_FS_REMOVE_FILE
#  define LANDLOCK_ACCESS_FS_REMOVE_FILE (1ULL << 5)
#endif
#ifndef LANDLOCK_ACCESS_FS_MAKE_CHAR
#  define LANDLOCK_ACCESS_FS_MAKE_CHAR (1ULL << 6)
#endif
#ifndef LANDLOCK_ACCESS_FS_MAKE_DIR
#  define LANDLOCK_ACCESS_FS_MAKE_DIR (1ULL << 7)
#endif
#ifndef LANDLOCK_ACCESS_FS_MAKE_REG
#  define LANDLOCK_ACCESS_FS_MAKE_REG (1ULL << 8)
#endif
#ifndef LANDLOCK_ACCESS_FS_MAKE_SOCK
#  define LANDLOCK_ACCESS_FS_MAKE_SOCK (1ULL << 9)
#endif
#ifndef LANDLOCK_ACCESS_FS_MAKE_FIFO
#  define LANDLOCK_ACCESS_FS_MAKE_FIFO (1ULL << 10)
#endif
#ifndef LANDLOCK_ACCESS_FS_MAKE_BLOCK
#  define LANDLOCK_ACCESS_FS_MAKE_BLOCK (1ULL << 11)
#endif
#ifndef LANDLOCK_ACCESS_FS_MAKE_SYM
#  define LANDLOCK_ACCESS_FS_MAKE_SYM (1ULL << 12)
#endif
#ifndef LANDLOCK_ACCESS_FS_REFER
#  define LANDLOCK_ACCESS_FS_REFER (1ULL << 13)
#endif
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#  define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif
#ifndef LANDLOCK_ACCESS_FS_IOCTL
#  define LANDLOCK_ACCESS_FS_IOCTL (1ULL << 15)
#endif

#ifndef LANDLOCK_ACCESS_NET_BIND_TCP
#  define LANDLOCK_ACCESS_NET_BIND_TCP (1ULL << 0)
#endif
#ifndef LANDLOCK_ACCESS_NET_CONNECT_TCP
#  define LANDLOCK_ACCESS_NET_CONNECT_TCP (1ULL << 1)
#endif

#ifndef LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET
#  define LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0)
#endif
#ifndef LANDLOCK_SCOPE_SIGNAL
#  define LANDLOCK_SCOPE_SIGNAL (1ULL << 1)
#endif

#ifndef LANDLOCK_RESTRICT_SELF_LOG_SAME_EXEC_OFF
#  define LANDLOCK_RESTRICT_SELF_LOG_SAME_EXEC_OFF (1U << 0)
#endif
#ifndef LANDLOCK_RESTRICT_SELF_LOG_NEW_EXEC_ON
#  define LANDLOCK_RESTRICT_SELF_LOG_NEW_EXEC_ON (1U << 1)
#endif
#ifndef LANDLOCK_RESTRICT_SELF_LOG_SUBDOMAINS_OFF
#  define LANDLOCK_RESTRICT_SELF_LOG_SUBDOMAINS_OFF (1U << 2)
#endif

struct linux_landlock_ruleset_attr {
  uint64_t handled_access_fs;
  uint64_t handled_access_net;
  uint64_t scoped;
};

enum linux_landlock_rule_type : uint32_t {
  LINUX_LANDLOCK_RULE_PATH_BENEATH = 1,
  LINUX_LANDLOCK_RULE_NET_PORT,
};

struct linux_landlock_path_beneath_attr {
  uint64_t allowed_access;
  int32_t parent_fd;
} __attribute__((packed));

struct linux_landlock_net_port_attr {
  uint64_t allowed_access;
  uint64_t port;
};

static inline long
linux_landlock_create_ruleset(
    const struct linux_landlock_ruleset_attr* const attr,
    const size_t size,
    const uint32_t flags) {
  return syscall(__NR_landlock_create_ruleset, attr, size, flags);
}

static inline long
linux_landlock_add_rule(const int ruleset_fd,
                        const enum linux_landlock_rule_type rule_type,
                        const void* const rule_attr,
                        const uint32_t flags) {
  return syscall(__NR_landlock_add_rule, ruleset_fd, rule_type, rule_attr, flags);
}

static inline long
linux_landlock_restrict_self(const int ruleset_fd, const uint32_t flags) {
  return syscall(__NR_landlock_restrict_self, ruleset_fd, flags);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Throw a JS Error with a message that includes the errno name and string.
 * `node-addon-api`'s Napi::Error::New(env, msg) does NOT have a 3-arg
 * (env, errno, msg) variant in 8.x — we have to roll our own. We also
 * set the `.code` property to the canonical "ERRNO_NAME" so the JS side
 * can branch on it.
 */
static void ThrowErrno(const Napi::Env& env,
                       const char* syscall_label,
                       int err) {
  std::string msg = std::string(syscall_label) + ": errno=" + std::to_string(err) +
                    " (" + std::strerror(err) + ")";
  Napi::Error err_obj = Napi::Error::New(env, msg);
  err_obj.Set("code", Napi::String::New(env, "ELANDLOCK"));
  err_obj.Set("syscall", Napi::String::New(env, syscall_label));
  err_obj.Set("errno_", Napi::Number::New(env, err));
  err_obj.ThrowAsJavaScriptException();
}

/** Throw a JS TypeError with a message. */
static void ThrowType(const Napi::Env& env, const std::string& msg) {
  Napi::TypeError::New(env, msg).ThrowAsJavaScriptException();
}

/** Throw a JS RangeError with a message. */
static void ThrowRange(const Napi::Env& env, const std::string& msg) {
  Napi::RangeError::New(env, msg).ThrowAsJavaScriptException();
}

// ---------------------------------------------------------------------------
// JS argument helpers. Mirror mscdex's uint64_value: number, BigInt, or
// (for small values) integer-typed Number all coerce to uint64_t.
// ---------------------------------------------------------------------------

static bool uint64_value(const Napi::Env& env,
                         const Napi::Value& val,
                         uint64_t* out) {
  if (val.IsNumber()) {
    double d = val.As<Napi::Number>().DoubleValue();
    if (d < 0.0) {
      ThrowType(env, "value must be non-negative");
      return false;
    }
    *out = static_cast<uint64_t>(d);
    return true;
  }
  if (val.IsBigInt()) {
    bool lossless;
    uint64_t v = val.As<Napi::BigInt>().Uint64Value(&lossless);
    if (!lossless) {
      ThrowType(env, "BigInt value out of uint64 range");
      return false;
    }
    *out = v;
    return true;
  }
  ThrowType(env, "value must be a number or BigInt");
  return false;
}

// ---------------------------------------------------------------------------
// Function: createRuleset(fsAccess[, netAccess[, scoped]]) -> number (fd)
// ---------------------------------------------------------------------------
static Napi::Value CreateRuleset(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1) {
    ThrowType(env, "Missing fs access argument");
    return env.Undefined();
  }

  struct linux_landlock_ruleset_attr ruleset;
  std::memset(&ruleset, 0, sizeof(ruleset));

  if (!uint64_value(env, info[0], &ruleset.handled_access_fs)) {
    return env.Undefined();
  }
  if (info.Length() > 1 && !uint64_value(env, info[1], &ruleset.handled_access_net)) {
    return env.Undefined();
  }
  if (info.Length() > 2 && !uint64_value(env, info[2], &ruleset.scoped)) {
    return env.Undefined();
  }

  int fd = static_cast<int>(linux_landlock_create_ruleset(
      &ruleset, sizeof(ruleset), 0));
  if (fd < 0) {
    ThrowErrno(env, "landlock_create_ruleset", errno);
    return env.Undefined();
  }
  return Napi::Number::New(env, fd);
}

// ---------------------------------------------------------------------------
// Function: close(fd) -> undefined
// ---------------------------------------------------------------------------
static Napi::Value Close(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    ThrowType(env, "Missing or invalid fd argument");
    return env.Undefined();
  }
  int fd = info[0].As<Napi::Number>().Int32Value();
  if (fd < 0) {
    ThrowType(env, "fd must be non-negative");
    return env.Undefined();
  }
  if (::close(fd) == -1) {
    ThrowErrno(env, "close", errno);
    return env.Undefined();
  }
  return env.Undefined();
}

// ---------------------------------------------------------------------------
// Function: addRule(fd, ruleType, allowedAccess, parent) -> undefined
//   ruleType:        number or BigInt, 1 = PATH_BENEATH, 2 = NET_PORT
//   allowedAccess:   number or BigInt bitmask
//   parent:          string (path) or int (fd)  — for PATH_BENEATH
//   for NET_PORT:    parent is a port number (uint32)
// ---------------------------------------------------------------------------
static Napi::Value AddRule(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 4) {
    ThrowType(env, "addRule requires (fd, ruleType, allowedAccess, parent)");
    return env.Undefined();
  }

  if (!info[0].IsNumber()) {
    ThrowType(env, "fd must be a number");
    return env.Undefined();
  }
  int fd = info[0].As<Napi::Number>().Int32Value();
  if (fd < 0) {
    ThrowType(env, "fd must be non-negative");
    return env.Undefined();
  }

  // ruleType — number or BigInt that fits in uint32.
  uint64_t rule_type_u64 = 0;
  if (!uint64_value(env, info[1], &rule_type_u64)) {
    return env.Undefined();
  }
  if (rule_type_u64 > std::numeric_limits<uint32_t>::max()) {
    ThrowType(env, "ruleType out of uint32 range");
    return env.Undefined();
  }
  auto rule_type = static_cast<enum linux_landlock_rule_type>(rule_type_u64);

  int ret = -1;
  switch (rule_type) {
    case LINUX_LANDLOCK_RULE_PATH_BENEATH: {
      struct linux_landlock_path_beneath_attr attr;
      std::memset(&attr, 0, sizeof(attr));

      uint64_t allowed_access = 0;
      if (!uint64_value(env, info[2], &allowed_access)) {
        return env.Undefined();
      }
      attr.allowed_access = allowed_access;

      bool need_close = false;
      if (info[3].IsString()) {
        std::string path = info[3].As<Napi::String>().Utf8Value();
        attr.parent_fd = ::open(path.c_str(), O_PATH | O_CLOEXEC);
        if (attr.parent_fd < 0) {
          ThrowErrno(env, "open", errno);
          return env.Undefined();
        }
        need_close = true;
      } else if (info[3].IsNumber()) {
        int32_t parent = info[3].As<Napi::Number>().Int32Value();
        if (parent < 0) {
          ThrowType(env, "parent fd must be non-negative");
          return env.Undefined();
        }
        attr.parent_fd = parent;
      } else {
        ThrowType(env, "parent must be a string (path) or number (fd)");
        return env.Undefined();
      }

      ret = static_cast<int>(linux_landlock_add_rule(fd, rule_type, &attr, 0));
      if (need_close) {
        ::close(attr.parent_fd);
      }
      break;
    }
    case LINUX_LANDLOCK_RULE_NET_PORT: {
      struct linux_landlock_net_port_attr attr;
      std::memset(&attr, 0, sizeof(attr));

      uint64_t allowed_access = 0;
      if (!uint64_value(env, info[2], &allowed_access)) {
        return env.Undefined();
      }
      attr.allowed_access = allowed_access;

      if (!info[3].IsNumber()) {
        ThrowType(env, "port must be a number");
        return env.Undefined();
      }
      uint32_t port = info[3].As<Napi::Number>().Uint32Value();
      if (port > 65535) {
        ThrowRange(env, "port must be <= 65535");
        return env.Undefined();
      }
      attr.port = port;

      ret = static_cast<int>(linux_landlock_add_rule(fd, rule_type, &attr, 0));
      break;
    }
    default:
      ThrowType(env, "Unsupported ruleType");
      return env.Undefined();
  }

  if (ret == -1) {
    ThrowErrno(env, "landlock_add_rule", errno);
    return env.Undefined();
  }
  return env.Undefined();
}

// ---------------------------------------------------------------------------
// Function: restrictSelf(fd[, flags]) -> undefined
// ---------------------------------------------------------------------------
static Napi::Value RestrictSelf(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    ThrowType(env, "Missing or invalid fd argument");
    return env.Undefined();
  }
  int fd = info[0].As<Napi::Number>().Int32Value();
  if (fd < 0) {
    ThrowType(env, "fd must be non-negative");
    return env.Undefined();
  }

  uint32_t flags = 0;
  if (info.Length() > 1) {
    if (info[1].IsNumber()) {
      flags = info[1].As<Napi::Number>().Uint32Value();
    } else {
      uint64_t f = 0;
      if (!uint64_value(env, info[1], &f)) {
        return env.Undefined();
      }
      if (f > std::numeric_limits<uint32_t>::max()) {
        ThrowType(env, "flags out of uint32 range");
        return env.Undefined();
      }
      flags = static_cast<uint32_t>(f);
    }
  }

  int ret = static_cast<int>(linux_landlock_restrict_self(fd, flags));
  if (ret == -1) {
    ThrowErrno(env, "landlock_restrict_self", errno);
    return env.Undefined();
  }
  return env.Undefined();
}

// ---------------------------------------------------------------------------
// Function: getABI() -> number  (1..7 on a kernel with landlock; throws otherwise)
// ---------------------------------------------------------------------------
static Napi::Value GetABI(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  long abi = linux_landlock_create_ruleset(
      nullptr, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 0) {
    ThrowErrno(env, "landlock_create_ruleset", errno);
    return env.Undefined();
  }
  return Napi::Number::New(env, static_cast<uint32_t>(abi));
}

// ---------------------------------------------------------------------------
// Function: getErrata() -> BigInt
// ---------------------------------------------------------------------------
static Napi::Value GetErrata(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  long errata = linux_landlock_create_ruleset(
      nullptr, 0, LANDLOCK_CREATE_RULESET_ERRATA);
  if (errata < 0) {
    ThrowErrno(env, "landlock_create_ruleset", errno);
    return env.Undefined();
  }
  return Napi::BigInt::New(env, static_cast<int64_t>(errata));
}

// ---------------------------------------------------------------------------
// Function: setNoNewPrivs() -> undefined
// ---------------------------------------------------------------------------
static Napi::Value SetNoNewPrivs(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (prctl(PR_SET_NO_NEW_PRIVS, 1L, 0L, 0L, 0L) < 0) {
    ThrowErrno(env, "prctl", errno);
    return env.Undefined();
  }
  return env.Undefined();
}

// ---------------------------------------------------------------------------
// Module init
// ---------------------------------------------------------------------------
static Napi::Object SetConstU64(const Napi::Env& env,
                                Napi::Object target,
                                const char* name,
                                uint64_t value) {
  target.Set(name, Napi::BigInt::New(env, value));
  return target;
}

static Napi::Object SetConstU32(const Napi::Env& env,
                                Napi::Object target,
                                const char* name,
                                uint32_t value) {
  // Napi::BigInt::New has no uint32_t overload; widen.
  target.Set(name, Napi::BigInt::New(env, static_cast<uint64_t>(value)));
  return target;
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("addRule", Napi::Function::New(env, AddRule));
  exports.Set("close", Napi::Function::New(env, Close));
  exports.Set("createRuleset", Napi::Function::New(env, CreateRuleset));
  exports.Set("getABI", Napi::Function::New(env, GetABI));
  exports.Set("getErrata", Napi::Function::New(env, GetErrata));
  exports.Set("restrictSelf", Napi::Function::New(env, RestrictSelf));
  exports.Set("setNoNewPrivs", Napi::Function::New(env, SetNoNewPrivs));

  Napi::Object constants = Napi::Object::New(env);
  SetConstU64(env, constants, "LANDLOCK_ACCESS_FS_EXECUTE", LANDLOCK_ACCESS_FS_EXECUTE);
  SetConstU64(env, constants, "LANDLOCK_ACCESS_FS_WRITE_FILE", LANDLOCK_ACCESS_FS_WRITE_FILE);
  SetConstU64(env, constants, "LANDLOCK_ACCESS_FS_READ_FILE", LANDLOCK_ACCESS_FS_READ_FILE);
  SetConstU64(env, constants, "LANDLOCK_ACCESS_FS_READ_DIR", LANDLOCK_ACCESS_FS_READ_DIR);
  SetConstU64(env, constants, "LANDLOCK_ACCESS_FS_REMOVE_DIR", LANDLOCK_ACCESS_FS_REMOVE_DIR);
  SetConstU64(env, constants, "LANDLOCK_ACCESS_FS_REMOVE_FILE", LANDLOCK_ACCESS_FS_REMOVE_FILE);
  SetConstU64(env, constants, "LANDLOCK_ACCESS_FS_MAKE_CHAR", LANDLOCK_ACCESS_FS_MAKE_CHAR);
  SetConstU64(env, constants, "LANDLOCK_ACCESS_FS_MAKE_DIR", LANDLOCK_ACCESS_FS_MAKE_DIR);
  SetConstU64(env, constants, "LANDLOCK_ACCESS_FS_MAKE_REG", LANDLOCK_ACCESS_FS_MAKE_REG);
  SetConstU64(env, constants, "LANDLOCK_ACCESS_FS_MAKE_SOCK", LANDLOCK_ACCESS_FS_MAKE_SOCK);
  SetConstU64(env, constants, "LANDLOCK_ACCESS_FS_MAKE_FIFO", LANDLOCK_ACCESS_FS_MAKE_FIFO);
  SetConstU64(env, constants, "LANDLOCK_ACCESS_FS_MAKE_BLOCK", LANDLOCK_ACCESS_FS_MAKE_BLOCK);
  SetConstU64(env, constants, "LANDLOCK_ACCESS_FS_MAKE_SYM", LANDLOCK_ACCESS_FS_MAKE_SYM);
  SetConstU64(env, constants, "LANDLOCK_ACCESS_FS_REFER", LANDLOCK_ACCESS_FS_REFER);
  SetConstU64(env, constants, "LANDLOCK_ACCESS_FS_TRUNCATE", LANDLOCK_ACCESS_FS_TRUNCATE);
  SetConstU64(env, constants, "LANDLOCK_ACCESS_FS_IOCTL", LANDLOCK_ACCESS_FS_IOCTL);

  SetConstU64(env, constants, "LANDLOCK_ACCESS_NET_BIND_TCP", LANDLOCK_ACCESS_NET_BIND_TCP);
  SetConstU64(env, constants, "LANDLOCK_ACCESS_NET_CONNECT_TCP", LANDLOCK_ACCESS_NET_CONNECT_TCP);

  SetConstU64(env, constants, "LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET", LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET);
  SetConstU64(env, constants, "LANDLOCK_SCOPE_SIGNAL", LANDLOCK_SCOPE_SIGNAL);

  SetConstU32(env, constants, "LANDLOCK_RESTRICT_SELF_LOG_SAME_EXEC_OFF", LANDLOCK_RESTRICT_SELF_LOG_SAME_EXEC_OFF);
  SetConstU32(env, constants, "LANDLOCK_RESTRICT_SELF_LOG_NEW_EXEC_ON", LANDLOCK_RESTRICT_SELF_LOG_NEW_EXEC_ON);
  SetConstU32(env, constants, "LANDLOCK_RESTRICT_SELF_LOG_SUBDOMAINS_OFF", LANDLOCK_RESTRICT_SELF_LOG_SUBDOMAINS_OFF);

  // Rule-type enum — the kernel assigns these starting at 1, so the values
  // are 1 (PATH_BENEATH) and 2 (NET_PORT). We export them as BigInts to
  // match upstream's API.
  SetConstU32(env, constants, "LANDLOCK_RULE_PATH_BENEATH", LINUX_LANDLOCK_RULE_PATH_BENEATH);
  SetConstU32(env, constants, "LANDLOCK_RULE_NET_PORT", LINUX_LANDLOCK_RULE_NET_PORT);

  exports.Set("constants", constants);
  return exports;
}

NODE_API_MODULE(landlock, Init)

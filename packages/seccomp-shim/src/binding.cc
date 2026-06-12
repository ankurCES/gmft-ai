// @gmft/seccomp-shim — N-API binding to Linux's seccomp BPF filter install.
//
// Tiny by design. The BPF program itself is built in pure JS (see
// packages/tools/src/shared/bpf.ts) — this shim only handles the
// two syscalls that have no Node 22+ binding:
//   - prctl(PR_SET_NO_NEW_PRIVS, 1)         — required before seccomp(2)
//   - seccomp(SECCOMP_SET_MODE_FILTER, 0, &prog) — install the BPF filter
//
// The BPF program is passed in as a Buffer. The shim does NOT validate
// the program's semantics — the JS emitter is the single source of truth
// for what filter we're installing, and the unit tests assert on the
// emitted byte sequence directly (no kernel required).
//
// Public API surface (JS):
//   const sc = require('@gmft/seccomp-shim');
//   sc.constants.PR_SET_NO_NEW_PRIVS        // number
//   sc.constants.SECCOMP_SET_MODE_FILTER    // number
//   sc.constants.SECCOMP_FILTER_FLAG_TSYNC  // number (0 unless kernel supports it)
//   sc.arch()                                // 'x86_64' | 'aarch64' | etc
//   sc.prctlSetNoNewPrivs()                  // throws on failure
//   sc.installBpf(bpfBytes, flags)           // throws on EACCES/EPERM/etc
//
// Differences from libseccomp:
//   - No policy DSL. The BPF is a Uint8Array. You build it in JS.
//   - No libseccomp.so runtime dep.
//   - The shim does NOT parse seccomp()'s return value; on SECCOMP_RET_ERRNO
//     the caller reads errno via process.binding. We document the contract.

#include <napi.h>

#include <cerrno>
#include <cstring>
#include <limits>
#include <string>
#include <vector>

#include <fcntl.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef __linux__
#  error "This addon only supports Linux"
#endif

// ---------------------------------------------------------------------------
// Constants. Mirror kernel headers (linux/prctl.h, linux/seccomp.h).
// ---------------------------------------------------------------------------

#ifndef PR_SET_NO_NEW_PRIVS
#  define PR_SET_NO_NEW_PRIVS 38
#endif

#ifndef PR_SET_SECCOMP
#  define PR_SET_SECCOMP 22
#endif

#ifndef PR_GET_SECCOMP
#  define PR_GET_SECCOMP 21
#endif

#ifndef SECCOMP_MODE_DISABLED
#  define SECCOMP_MODE_DISABLED 0
#endif
#ifndef SECCOMP_MODE_STRICT
#  define SECCOMP_MODE_STRICT 1
#endif
#ifndef SECCOMP_MODE_FILTER
#  define SECCOMP_MODE_FILTER 2
#endif

#ifndef SECCOMP_SET_MODE_STRICT
#  define SECCOMP_SET_MODE_STRICT 0
#endif
#ifndef SECCOMP_SET_MODE_FILTER
#  define SECCOMP_SET_MODE_FILTER 1
#endif

#ifndef SECCOMP_FILTER_FLAG_TSYNC
#  define SECCOMP_FILTER_FLAG_TSYNC (1U << 0)
#endif
#ifndef SECCOMP_FILTER_FLAG_LOG
#  define SECCOMP_FILTER_FLAG_LOG (1U << 1)
#endif
#ifndef SECCOMP_FILTER_FLAG_SPEC_ALLOW
#  define SECCOMP_FILTER_FLAG_SPEC_ALLOW (1U << 2)
#endif
#ifndef SECCOMP_FILTER_FLAG_NEW_LISTENER
#  define SECCOMP_FILTER_FLAG_NEW_LISTENER (1U << 3)
#endif
#ifndef SECCOMP_FILTER_FLAG_TSYNC_ESRCH
#  define SECCOMP_FILTER_FLAG_TSYNC_ESRCH (1U << 4)
#endif

// seccomp(2) syscall number. No glibc wrapper for it in many distros.
#ifndef __NR_seccomp
#  if defined(__x86_64__)
#    define __NR_seccomp 317
#  elif defined(__i386__)
#    define __NR_seccomp 354
#  elif defined(__aarch64__)
#    define __NR_seccomp 277
#  elif defined(__arm__)
#    define __NR_seccomp 383
#  elif defined(__s390__) || defined(__s390x__)
#    define __NR_seccomp 348
#  elif defined(__powerpc__)
#    define __NR_seccomp 358
#  elif defined(__powerpc64__)
#    define __NR_seccomp 358
#  elif defined(__riscv) || defined(__riscv__)
#    define __NR_seccomp 277
#  elif defined(__mips__) || defined(__mips64__)
#    define __NR_seccomp 4352
#  else
#    error "Unsupported architecture for __NR_seccomp"
#  endif
#endif

// ---------------------------------------------------------------------------
// sock_filter + sock_fprog. These come from <linux/filter.h> but we
// re-declare them here to avoid pulling in the full header and to make
// the layout obvious to readers.
// ---------------------------------------------------------------------------

struct linux_sock_filter {
  uint16_t code;
  uint8_t  jt;
  uint8_t  jf;
  uint32_t k;
};

struct linux_sock_fprog {
  unsigned short len;
  struct linux_sock_filter* filter;
};

// ---------------------------------------------------------------------------
// Error helpers — same shape as landlock-shim so the JS side can branch
// on a stable `code` field.
// ---------------------------------------------------------------------------

static void ThrowErrno(const Napi::Env& env,
                       const char* syscall_label,
                       int err) {
  std::string msg = std::string(syscall_label) + ": errno=" + std::to_string(err) +
                    " (" + std::strerror(err) + ")";
  Napi::Error err_obj = Napi::Error::New(env, msg);
  err_obj.Set("code", Napi::String::New(env, "ESECCOMP"));
  err_obj.Set("syscall", Napi::String::New(env, syscall_label));
  err_obj.Set("errno_", Napi::Number::New(env, err));
  err_obj.ThrowAsJavaScriptException();
}

static void ThrowType(const Napi::Env& env, const std::string& msg) {
  Napi::TypeError::New(env, msg).ThrowAsJavaScriptException();
}

// ---------------------------------------------------------------------------
// arch() -> string
//
// Reports the architecture the kernel sees this process as. We use
// this to validate that the BPF program we are about to install
// matches the kernel's expected audit arch. The JS side passes
// SECCOMP_AUDIT_ARCH_NATIVE implicitly by building the BPF with
// the right arch constant.
// ---------------------------------------------------------------------------
static Napi::Value Arch(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
#if defined(__x86_64__)
  return Napi::String::New(env, "x86_64");
#elif defined(__i386__)
  return Napi::String::New(env, "i386");
#elif defined(__aarch64__)
  return Napi::String::New(env, "aarch64");
#elif defined(__arm__)
  return Napi::String::New(env, "arm");
#elif defined(__s390x__)
  return Napi::String::New(env, "s390x");
#elif defined(__s390__)
  return Napi::String::New(env, "s390");
#elif defined(__powerpc64__)
  return Napi::String::New(env, "powerpc64");
#elif defined(__powerpc__)
  return Napi::String::New(env, "powerpc");
#elif defined(__riscv) || defined(__riscv__)
  return Napi::String::New(env, "riscv64");
#elif defined(__mips64__)
  return Napi::String::New(env, "mips64");
#elif defined(__mips__)
  return Napi::String::New(env, "mips");
#else
  return Napi::String::New(env, "unknown");
#endif
}

// ---------------------------------------------------------------------------
// prctlSetNoNewPrivs() -> undefined
//
// MUST be called before installBpf(). The seccomp(2) syscall will
// fail with EACCES if no_new_privs is not set on the caller.
// ---------------------------------------------------------------------------
static Napi::Value PrctlSetNoNewPrivs(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (prctl(PR_SET_NO_NEW_PRIVS, 1L, 0L, 0L, 0L) < 0) {
    ThrowErrno(env, "prctl(PR_SET_NO_NEW_PRIVS)", errno);
    return env.Undefined();
  }
  return env.Undefined();
}

// ---------------------------------------------------------------------------
// prctlGetSeccomp() -> number
//
// Returns the current seccomp mode of the calling thread
// (0=disabled, 1=strict, 2=filter). The JS probe in
// packages/tools/src/shared/seccomp.ts reads /proc/self/status
// instead — but this is exported for symmetry and for tests that
// want to assert "installBpf actually moved us to mode 2".
// ---------------------------------------------------------------------------
static Napi::Value PrctlGetSeccomp(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  // prctl() returns the value on success; -1 on failure with errno set.
  long mode = prctl(PR_GET_SECCOMP, 0L, 0L, 0L, 0L);
  if (mode < 0) {
    ThrowErrno(env, "prctl(PR_GET_SECCOMP)", errno);
    return env.Undefined();
  }
  return Napi::Number::New(env, static_cast<int32_t>(mode));
}

// ---------------------------------------------------------------------------
// installBpf(bpfBytes: Buffer, flags: number) -> undefined
//
// bpfBytes is a Buffer of len(BPF) * 8 bytes — each sock_filter is
// {u16 code, u8 jt, u8 jf, u32 k} in little-endian, which is exactly
// the on-the-wire layout. The JS emitter builds this directly.
//
// We do NOT bounds-check the BPF semantics here — that's the JS side's
// job. We only check (a) the buffer length is a multiple of 8, and
// (b) the BPF count fits in unsigned short.
// ---------------------------------------------------------------------------
static Napi::Value InstallBpf(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsBuffer()) {
    ThrowType(env, "installBpf requires (Buffer bpfBytes[, number flags])");
    return env.Undefined();
  }

  Napi::Buffer<uint8_t> buf = info[0].As<Napi::Buffer<uint8_t>>();
  size_t byte_len = buf.Length();
  if (byte_len == 0 || (byte_len % sizeof(struct linux_sock_filter)) != 0) {
    ThrowType(env, "bpfBytes length must be a non-zero multiple of 8");
    return env.Undefined();
  }
  size_t n = byte_len / sizeof(struct linux_sock_filter);
  if (n > std::numeric_limits<unsigned short>::max()) {
    ThrowType(env, "BPF program too long (limit 65535 instructions)");
    return env.Undefined();
  }

  // Re-interpret the Buffer as a struct linux_sock_filter array.
  // The buffer's backing memory is allocated and aligned by libuv and
  // is safe to cast here. We make a copy into a vector so the kernel
  // sees a stable pointer (Buffer data may be relocated by GC).
  std::vector<struct linux_sock_filter> prog;
  prog.resize(n);
  std::memcpy(prog.data(), buf.Data(), byte_len);

  struct linux_sock_fprog fprog;
  fprog.len = static_cast<unsigned short>(n);
  fprog.filter = prog.data();

  // Flags default to 0 (caller-only filter, no TSYNC, no LOG).
  uint32_t flags = 0;
  if (info.Length() > 1 && info[1].IsNumber()) {
    flags = info[1].As<Napi::Number>().Uint32Value();
  }

  long ret = syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER, flags, &fprog);
  if (ret < 0) {
    ThrowErrno(env, "seccomp(SECCOMP_SET_MODE_FILTER)", errno);
    return env.Undefined();
  }
  return env.Undefined();
}

// ---------------------------------------------------------------------------
// Module init
// ---------------------------------------------------------------------------
static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("arch", Napi::Function::New(env, Arch));
  exports.Set("prctlSetNoNewPrivs", Napi::Function::New(env, PrctlSetNoNewPrivs));
  exports.Set("prctlGetSeccomp", Napi::Function::New(env, PrctlGetSeccomp));
  exports.Set("installBpf", Napi::Function::New(env, InstallBpf));

  Napi::Object constants = Napi::Object::New(env);
  constants.Set("PR_SET_NO_NEW_PRIVS", Napi::Number::New(env, PR_SET_NO_NEW_PRIVS));
  constants.Set("PR_SET_SECCOMP", Napi::Number::New(env, PR_SET_SECCOMP));
  constants.Set("PR_GET_SECCOMP", Napi::Number::New(env, PR_GET_SECCOMP));
  constants.Set("SECCOMP_MODE_DISABLED", Napi::Number::New(env, SECCOMP_MODE_DISABLED));
  constants.Set("SECCOMP_MODE_STRICT", Napi::Number::New(env, SECCOMP_MODE_STRICT));
  constants.Set("SECCOMP_MODE_FILTER", Napi::Number::New(env, SECCOMP_MODE_FILTER));
  constants.Set("SECCOMP_SET_MODE_STRICT", Napi::Number::New(env, SECCOMP_SET_MODE_STRICT));
  constants.Set("SECCOMP_SET_MODE_FILTER", Napi::Number::New(env, SECCOMP_SET_MODE_FILTER));
  constants.Set("SECCOMP_FILTER_FLAG_TSYNC", Napi::Number::New(env, SECCOMP_FILTER_FLAG_TSYNC));
  constants.Set("SECCOMP_FILTER_FLAG_LOG", Napi::Number::New(env, SECCOMP_FILTER_FLAG_LOG));
  constants.Set("SECCOMP_FILTER_FLAG_SPEC_ALLOW", Napi::Number::New(env, SECCOMP_FILTER_FLAG_SPEC_ALLOW));
  constants.Set("SECCOMP_FILTER_FLAG_NEW_LISTENER", Napi::Number::New(env, SECCOMP_FILTER_FLAG_NEW_LISTENER));
  constants.Set("SECCOMP_FILTER_FLAG_TSYNC_ESRCH", Napi::Number::New(env, SECCOMP_FILTER_FLAG_TSYNC_ESRCH));
  exports.Set("constants", constants);
  return exports;
}

NODE_API_MODULE(seccomp, Init)

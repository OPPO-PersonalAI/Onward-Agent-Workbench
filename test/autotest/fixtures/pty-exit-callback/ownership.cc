// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
#include <cassert>
#include <cstdlib>
#include <new>
#include "onward_exit_callback.h"

static void* tracked = nullptr;
static int deleted = 0, calls = 0, released = 0, argument = 0;
static bool pending = false, immediate = false;
static napi_status status = napi_ok, enqueue = napi_ok;
static void* queued = nullptr;
static void* env = reinterpret_cast<void*>(1);
void* operator new(std::size_t size) { if (auto p = std::malloc(size)) return p; throw std::bad_alloc(); }
void operator delete(void* p) noexcept { if (p && p == tracked) { ++deleted; tracked = nullptr; } std::free(p); }
void operator delete(void* p, std::size_t) noexcept { ::operator delete(p); }
napi_status napi_get_undefined(napi_env, napi_value* out) { *out = env; return napi_ok; }
napi_status napi_create_int32(napi_env, int32_t value, napi_value* out) { argument = value; *out = env; return napi_ok; }
napi_status napi_call_function(napi_env, napi_value, napi_value, size_t count, const napi_value*, napi_value*) {
  assert(count == 1); ++calls; return status;
}
napi_status napi_call_threadsafe_function(napi_threadsafe_function, void* payload, napi_threadsafe_function_call_mode) {
  if (enqueue == napi_ok) {
    if (immediate) onward_pty::CallExit(env, env, nullptr, payload);
    else queued = payload;
  }
  return enqueue;
}
napi_status napi_release_threadsafe_function(napi_threadsafe_function, napi_threadsafe_function_release_mode) { ++released; return napi_ok; }
static std::unique_ptr<onward_pty::ExitEvent> event() {
  deleted = calls = released = 0;
  auto value = std::make_unique<onward_pty::ExitEvent>();
  value->exit_code = 42; tracked = value.get(); return value;
}
int main() {
  for (auto s : {napi_ok, napi_pending_exception, napi_cannot_run_js, napi_generic_failure}) {
    for (bool realException : {false, true}) {
      status = s; pending = realException;
      onward_pty::CallExit(env, env, nullptr, event().release());
      assert(deleted == 1 && calls == 1 && argument == 42 && pending == realException);
    }
  }
  onward_pty::CallExit(nullptr, nullptr, nullptr, event().release());
  assert(deleted == 1 && calls == 0);
  onward_pty::CallExit(env, nullptr, nullptr, event().release());
  assert(deleted == 1 && calls == 0);
  status = napi_ok;
  for (auto s : {napi_ok, napi_closing, napi_queue_full, napi_generic_failure}) {
    enqueue = s; immediate = false;
    onward_pty::QueueExit(env, event());
    assert(released == (s == napi_closing ? 0 : 1));
    if (s == napi_ok) {
      assert(deleted == 0);
      onward_pty::CallExit(nullptr, nullptr, nullptr, queued);
    }
    assert(deleted == 1);
  }
  enqueue = napi_ok; immediate = true;
  onward_pty::QueueExit(env, event());
  assert(deleted == 1 && calls == 1 && released == 1);
  std::puts("PTY-NATIVE ownership/status cases passed");
}

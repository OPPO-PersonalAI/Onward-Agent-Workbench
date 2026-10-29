// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
#include <node_api.h>
#include "onward_exit_callback.h"

static napi_value Run(napi_env env, napi_callback_info info) {
  napi_value callback;
  size_t count = 1;
  if (napi_get_cb_info(env, info, &count, &callback, nullptr, nullptr) != napi_ok) return nullptr;
  auto event = std::make_unique<onward_pty::ExitEvent>();
  event->exit_code = 42;
  onward_pty::CallExit(env, callback, nullptr, event.release());
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (pending) return nullptr;
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}
static napi_value Init(napi_env env, napi_value exports) {
  napi_value run;
  napi_create_function(env, "run", NAPI_AUTO_LENGTH, Run, nullptr, &run);
  napi_set_named_property(env, exports, "run", run);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)

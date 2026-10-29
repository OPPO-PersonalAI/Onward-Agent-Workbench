// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
#pragma once
#include <cstddef>
#include <cstdint>
using napi_env = void*;
using napi_value = void*;
using napi_threadsafe_function = void*;
enum napi_status { napi_ok, napi_invalid_arg, napi_generic_failure, napi_pending_exception,
  napi_cannot_run_js, napi_closing, napi_queue_full };
enum napi_threadsafe_function_call_mode { napi_tsfn_blocking };
enum napi_threadsafe_function_release_mode { napi_tsfn_release };
napi_status napi_get_undefined(napi_env, napi_value*);
napi_status napi_create_int32(napi_env, int32_t, napi_value*);
napi_status napi_call_function(napi_env, napi_value, napi_value, size_t, const napi_value*, napi_value*);
napi_status napi_call_threadsafe_function(napi_threadsafe_function, void*, napi_threadsafe_function_call_mode);
napi_status napi_release_threadsafe_function(napi_threadsafe_function, napi_threadsafe_function_release_mode);

// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
// Test-package instrumentation persists through installer-triggered relaunches.
require('electron').app.commandLine.appendSwitch('remote-debugging-port', '__CDP_PORT__');

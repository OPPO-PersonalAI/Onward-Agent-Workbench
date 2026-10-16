/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: {
          index: resolve(__dirname, 'electron/main/index.ts'),
          'git-status-worker-entry': resolve(__dirname, 'electron/main/git-status-worker-entry.ts'),
          'git-ipc-worker-entry': resolve(__dirname, 'electron/main/git-ipc-worker-entry.ts'),
          'git-state-mirror-worker-entry': resolve(__dirname, 'electron/main/git-state-mirror-worker-entry.ts'),
          'watcher-service-entry': resolve(__dirname, 'electron/main/watcher-service-entry.ts'),
          'watcher-owner-watchdog-entry': resolve(__dirname, 'electron/main/watcher-owner-watchdog-entry.ts'),
          'sqlite-worker-entry': resolve(__dirname, 'electron/main/sqlite-worker-entry.ts'),
          'app-state-worker-entry': resolve(__dirname, 'electron/main/app-state-worker-entry.ts'),
          'project-fs-worker-entry': resolve(__dirname, 'electron/main/project-fs-worker-entry.ts'),
          'theme-import-worker-entry': resolve(__dirname, 'electron/main/theme-import-worker-entry.ts'),
          'theme-export-worker-entry': resolve(__dirname, 'electron/main/theme-export-worker-entry.ts'),
          'ripgrep-search-worker-entry': resolve(__dirname, 'electron/main/ripgrep-search-worker-entry.ts')
        },
        formats: ['cjs']
      },
      rollupOptions: {
        external: ['node-pty'],
        output: {
          entryFileNames: '[name].js'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: resolve(__dirname, 'electron/preload/index.ts')
      }
    }
  },
  renderer: {
    root: '.',
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'index.html')
      }
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src')
      }
    }
  }
})

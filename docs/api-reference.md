<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# API Reference

## Project Structure

```
.
├── docs/                           # Documentation directory
│   ├── architecture.md             # System architecture
│   ├── design-decisions.md         # Technology choices
│   └── api-reference.md            # This file
├── electron/                       # Electron main process and preload layer
│   ├── main/
│   │   ├── index.ts                # Application entry point
│   │   ├── pty-manager.ts          # PTY lifecycle management
│   │   └── ipc-handlers.ts         # IPC message routing
│   └── preload/
│       └── index.ts                # Context bridge for secure IPC
├── src/                            # React renderer process
│   ├── components/
│   │   ├── Terminal/
│   │   │   ├── Terminal.tsx        # xterm.js wrapper component
│   │   │   └── Terminal.css        # Terminal styles
│   │   └── TerminalTabs/
│   │       ├── TerminalTabs.tsx    # Tab management component
│   │       └── TerminalTabs.css    # Tab bar styles
│   ├── themes/
│   │   └── terminal-themes.ts      # Color theme definitions
│   ├── types/
│   │   └── electron.d.ts           # TypeScript declarations
│   ├── App.tsx                     # Root component
│   ├── App.css                     # Global styles
│   └── main.tsx                    # React entry point
├── electron.vite.config.ts         # Build configuration
├── package.json                    # Dependencies and scripts
├── tsconfig.json                   # TypeScript configuration
└── index.html                      # HTML template
```

## Main Process API

### `PtyManager` Class

Location: `electron/main/pty-manager.ts`

```typescript
class PtyManager {
  /**
   * Create a new PTY instance.
   * @param id - Unique terminal identifier
   * @param window - BrowserWindow used to send events
   * @param options - PTY creation options
   * @returns Result object that includes success status
   */
  create(id: string, window: BrowserWindow, options?: PtyOptions): CreateResult

  /**
   * Write data to a PTY.
   * @param id - Terminal identifier
   * @param data - String data to write
   * @returns true on success
   */
  write(id: string, data: string): boolean

  /**
   * Resize a PTY.
   * @param id - Terminal identifier
   * @param cols - New column count
   * @param rows - New row count
   * @returns true on success
   */
  resize(id: string, cols: number, rows: number): boolean

  /**
   * Dispose of a PTY and terminate the shell process.
   * @param id - Terminal identifier
   * @returns true on success
   */
  dispose(id: string): boolean

  /**
   * Dispose of all PTY instances.
   */
  disposeAll(): void
}
```

### `PtyOptions` Interface

```typescript
interface PtyOptions {
  cols?: number      // Initial column count (default: 80)
  rows?: number      // Initial row count (default: 24)
  cwd?: string       // Working directory (default: user's home directory)
}
```

### IPC Handlers

Location: `electron/main/ipc-handlers.ts`

| Channel | Handler | Parameters | Return value |
|------|--------|------|--------|
| `terminal:create` | Create a PTY | `id: string, options?: PtyOptions` | `{ success: boolean, id?: string, error?: string }` |
| `terminal:write` | Write to a PTY | `id: string, data: string` | `boolean` |
| `terminal:resize` | Resize a PTY | `id: string, cols: number, rows: number` | `boolean` |
| `terminal:dispose` | Dispose of a PTY | `id: string` | `boolean` |

### Events (Main Process -> Renderer Process)

| Event | Payload | Description |
|------|------|------|
| `terminal:data` | `{ id: string, data: string }` | PTY output data |
| `terminal:exit` | `{ id: string, exitCode: number, signal?: number }` | PTY has exited |

## Preload API

Location: `electron/preload/index.ts`

### `window.electronAPI.terminal`

```typescript
interface TerminalAPI {
  /**
   * Create a new terminal.
   */
  create(id: string, options?: TerminalOptions): Promise<CreateResult>

  /**
   * Write data to a terminal.
   */
  write(id: string, data: string): Promise<boolean>

  /**
   * Resize a terminal.
   */
  resize(id: string, cols: number, rows: number): Promise<boolean>

  /**
   * Dispose of a terminal.
   */
  dispose(id: string): Promise<boolean>

  /**
   * Subscribe to terminal data events.
   * @returns Unsubscribe function
   */
  onData(callback: (id: string, data: string) => void): () => void

  /**
   * Subscribe to terminal exit events.
   * @returns Unsubscribe function
   */
  onExit(callback: (id: string, exitCode: number, signal?: number) => void): () => void
}
```

## React Components

### `Terminal` Component

Location: `src/components/Terminal/Terminal.tsx`

```typescript
interface TerminalProps {
  id: string              // Unique terminal identifier
  isActive: boolean       // Whether this terminal is currently visible
  theme?: ITerminalTheme  // Optional color theme
  onExit?: () => void     // Called when the shell exits
}

function Terminal({ id, isActive, theme, onExit }: TerminalProps): JSX.Element
```

**Lifecycle**:
1. Mount: initialize xterm.js, load addons, and create the PTY.
2. Update: react to visibility changes and theme updates.
3. Unmount: dispose of xterm.js and destroy the PTY.

**Core behavior**:
- Automatically fit the terminal when the container size changes.
- Use WebGL rendering with a fallback path.
- Forward user input to the PTY.
- Display PTY output in the viewport.

### `TerminalTabs` Component

Location: `src/components/TerminalTabs/TerminalTabs.tsx`

```typescript
interface Tab {
  id: string       // Unique tab identifier
  title: string    // Display title
}

function TerminalTabs(): JSX.Element
```

**Features**:
- Create a new tab using the `+` button.
- Close a tab using the `x` button.
- Switch between tabs.
- Support shortcuts such as `Cmd/Ctrl+T` for new tabs.

## Theme System

Location: `src/themes/terminal-themes.ts`

### Available Themes

| Theme name | Description |
|----------|------|
| `vscodeDark` | VS Code Dark+ (default) |
| `dracula` | Dracula color scheme |
| `oneDark` | Atom One Dark |
| `monokai` | Monokai Pro |
| `solarizedDark` | Solarized Dark |

### Theme Interface

```typescript
interface ITerminalTheme {
  name: string
  // Background and foreground
  background: string
  foreground: string
  // Cursor
  cursor: string
  cursorAccent: string
  // Selection
  selectionBackground: string
  // Standard colors (0-7)
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  // Bright colors (8-15)
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}
```

### Usage

```typescript
import { themes } from '@/themes/terminal-themes'

// Get a theme by name
const theme = themes.dracula

// Apply it to the terminal
<Terminal id="1" isActive={true} theme={theme} />
```

## TypeScript Types

Location: `src/types/electron.d.ts`

```typescript
// Terminal creation options
export interface TerminalOptions {
  cols?: number
  rows?: number
  cwd?: string
}

// Terminal API exposed to the renderer
export interface TerminalAPI {
  create: (id: string, options?: TerminalOptions) => Promise<CreateResult>
  write: (id: string, data: string) => Promise<boolean>
  resize: (id: string, cols: number, rows: number) => Promise<boolean>
  dispose: (id: string) => Promise<boolean>
  onData: (callback: (id: string, data: string) => void) => () => void
  onExit: (callback: (id: string, exitCode: number, signal?: number) => void) => () => void
}

// Global window extension
declare global {
  interface Window {
    electronAPI: {
      terminal: TerminalAPI
    }
  }
}
```

## Build Scripts

| Script | Command | Description |
|------|------|------|
| `dev` | `electron-vite dev` | Start the development server with HMR |
| `build` | `electron-vite build` | Create a production build |
| `preview` | `electron-vite preview` | Preview the production build |
| `postinstall` | `electron-rebuild -f -w node-pty` | Rebuild the native module |

## Configuration Files

### `electron.vite.config.ts`

```typescript
export default defineConfig({
  main: {
    // Main process build configuration
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: 'electron/main/index.ts' },
      rollupOptions: { external: ['node-pty'] }
    }
  },
  preload: {
    // Preload build configuration
    plugins: [externalizeDepsPlugin()],
    build: { lib: { entry: 'electron/preload/index.ts' } }
  },
  renderer: {
    // React application build configuration
    plugins: [react()],
    resolve: { alias: { '@': resolve(__dirname, 'src') } }
  }
})
```

### `tsconfig.json`

Key settings:
- `strict: true` - Enable full strict type checking.
- `moduleResolution: bundler` - Use modern module resolution.
- `paths: { "@/*": ["./src/*"] }` - Define the path alias.

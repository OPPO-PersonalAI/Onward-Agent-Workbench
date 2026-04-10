# Mermaid Complex - Advanced Diagrams

## 1. Class Diagram - Design Patterns

```mermaid
classDiagram
    class EventEmitter {
        <<interface>>
        +on(event, listener) void
        +off(event, listener) void
        +emit(event, ...args) void
    }
    class AppState {
        -state: Map~string, unknown~
        -listeners: Set~Function~
        +get(key) unknown
        +set(key, value) void
        +subscribe(listener) Unsubscribe
    }
    class SettingsManager {
        -settings: AppSettings
        -filePath: string
        +load() Promise~void~
        +save() Promise~void~
        +get(key) unknown
        +update(key, value) void
    }
    class IPCBridge {
        -handlers: Map~string, Handler~
        +register(channel, handler) void
        +invoke(channel, ...args) Promise~unknown~
    }
    class TerminalManager {
        -terminals: Map~string, Terminal~
        -activeId: string
        +create(options) Terminal
        +destroy(id) void
        +getActive() Terminal
        +setActive(id) void
    }
    class Terminal {
        -pty: IPty
        -buffer: string[]
        +write(data) void
        +resize(cols, rows) void
        +kill() void
    }

    EventEmitter <|.. AppState
    EventEmitter <|.. SettingsManager
    AppState --> IPCBridge : uses
    SettingsManager --> IPCBridge : uses
    TerminalManager *-- Terminal
    TerminalManager --> AppState : observes
```

## 2. Sequence - Complex Async Flow

```mermaid
sequenceDiagram
    participant U as User
    participant E as Editor
    participant W as MD Worker
    participant D as DOMPurify
    participant MM as Mermaid
    participant FS as FileSystem

    U->>E: Type in editor
    activate E
    Note over E: Debounce 300-900ms<br/>(adaptive by file size)

    E->>W: postMessage({content, rootPath})
    activate W
    par Markdown Processing
        W->>W: marked.parse(content)
    and Image Resolution
        W->>W: walkTokens: resolve image paths
    end
    W-->>E: postMessage({html, imagePaths})
    deactivate W

    E->>D: sanitize(html)
    D-->>E: safeHtml

    E->>E: requestIdleCallback
    activate E
    E->>E: setMarkdownRenderedHtml(safeHtml)
    deactivate E

    Note over E: React re-render

    E->>E: useLayoutEffect: scroll sync
    E->>E: useEffect: update active slug

    opt Mermaid placeholders found
        E->>MM: import('mermaid')
        activate MM
        Note over MM: Lazy load ~1MB
        MM-->>E: module loaded
        loop Each .mermaid-diagram
            E->>MM: render(id, source)
            MM-->>E: {svg}
            E->>E: el.innerHTML = svg
        end
        deactivate MM
    end

    par Background Tasks
        E->>FS: Watch image files
        FS-->>E: File changed
        E->>E: Re-render affected images
    end
    deactivate E
```

## 3. Gitgraph

```mermaid
gitGraph
    commit id: "init"
    commit id: "v2.0.0"
    branch feature/mermaid
    checkout feature/mermaid
    commit id: "add mermaid dep"
    commit id: "worker placeholder"
    commit id: "shared renderer"
    commit id: "PE integration"
    commit id: "changelog support"
    checkout main
    commit id: "hotfix: scroll"
    merge feature/mermaid id: "merge mermaid" tag: "v2.1.0"
    commit id: "release prep"
    commit id: "v2.1.0" tag: "v2.1.0-daily"
```

## 4. Mindmap

```mermaid
mindmap
    root((Onward IDE))
        Terminal
            Multi-tab
            Shell integration
            Auto-follow
        Editor
            Monaco
            Markdown Preview
                GFM
                KaTeX Math
                Mermaid Diagrams
                Syntax Highlighting
            SQLite Viewer
        Git
            Diff View
            History
            Submodules
        Settings
            Themes
            Shortcuts
            Auto-update
                Daily channel
                Dev channel
```

## 5. Error Case (Syntax Error Test)

This block has intentional syntax errors to test error handling:

```mermaid
graph TD
    A --> B
    B --> C
    C -->
    INVALID SYNTAX HERE !!!
```

## 6. Mixed Content Stress Test

Regular text before a diagram.

```mermaid
graph LR
    Input --> Process --> Output
```

Some **bold** and *italic* text between diagrams, with `inline code` and a [link](https://example.com).

> A blockquote between mermaid blocks to verify DOM structure is preserved.

```mermaid
pie title Distribution
    "Diagrams" : 40
    "Code" : 35
    "Text" : 25
```

$$
E = mc^2
$$

A LaTeX formula above, followed by another diagram:

```mermaid
graph TD
    A[Mermaid] --> B[KaTeX]
    A --> C[Highlight.js]
    B --> D[Unified Preview]
    C --> D
```

| Feature | Status |
|---------|--------|
| GFM Tables | Done |
| KaTeX | Done |
| Mermaid | Done |

End of mixed content test.

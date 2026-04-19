# Mermaid Pan/Zoom Test Index

This directory contains fixtures used by the automated Mermaid pan/zoom test suite.

| Fixture | What it tests |
| --- | --- |
| [tiny.md](tiny.md) | Smallest possible diagram; ensures the enhancer does not inflate tiny SVGs |
| [medium.md](medium.md) | Moderately complex diagrams that fit the default viewport |
| [wide.md](wide.md) | Horizontally-wide flowchart — must be pannable |
| [tall.md](tall.md) | Vertically-tall sequence diagram — must be pannable |
| [huge.md](huge.md) | Dense large class diagram — must fit on zoom-out and be readable on zoom-in |
| [mixed-types.md](mixed-types.md) | One of each diagram type — covers flowchart, sequence, class, state, ER, gantt, pie, gitgraph, mindmap, journey |

These files are committed fixtures; do not delete.

# Mixed Mermaid Types

One of each major diagram type. Verifies the pan/zoom enhancer works regardless of underlying SVG structure.

## 1. Flowchart

```mermaid
flowchart TD
    A[Start] --> B{Choice}
    B -->|A| C[Result A]
    B -->|B| D[Result B]
    C --> E[End]
    D --> E
```

## 2. Sequence

```mermaid
sequenceDiagram
    Alice->>Bob: Hello
    Bob-->>Alice: Hi!
```

## 3. Class

```mermaid
classDiagram
    class Animal {
        +String name
        +makeSound() void
    }
    class Dog {
        +bark() void
    }
    Animal <|-- Dog
```

## 4. State

```mermaid
stateDiagram-v2
    [*] --> On
    On --> Off
    Off --> On
    Off --> [*]
```

## 5. Entity Relationship

```mermaid
erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ LINE : contains
    PRODUCT ||--o{ LINE : included_in
```

## 6. Gantt

```mermaid
gantt
    title Release Plan
    dateFormat  YYYY-MM-DD
    section Design
    Wireframes      :a1, 2026-04-01, 5d
    Visual Design   :after a1, 5d
    section Build
    Scaffold        :2026-04-12, 4d
    Feature Work    :2026-04-16, 10d
    section Ship
    QA              :2026-04-26, 4d
    Release         :2026-04-30, 1d
```

## 7. Pie

```mermaid
pie title Coverage
    "Covered" : 78
    "Missing" : 22
```

## 8. Git Graph

```mermaid
gitGraph
    commit
    branch feature
    checkout feature
    commit
    commit
    checkout main
    commit
    merge feature
    commit
```

## 9. Mindmap

```mermaid
mindmap
  root((Feature))
    UX
      Layout
      Interactions
    Logic
      Library
      Controller
    Tests
      Unit
      E2E
```

## 10. Journey

```mermaid
journey
    title Ship a feature
    section Plan
      Gather reqs: 4: PM
      Design UX: 5: Designer
    section Build
      Implement: 4: Engineer
      Review: 3: Engineer, Reviewer
    section Ship
      Test: 5: QA
      Release: 5: Release Manager
```

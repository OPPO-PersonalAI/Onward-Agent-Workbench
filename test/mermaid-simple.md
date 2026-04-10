# Mermaid Simple - Basic Diagrams

## 1. Flowchart

```mermaid
graph TD
    A[Start] --> B{Decision}
    B -->|Yes| C[OK]
    B -->|No| D[End]
    C --> D
```

## 2. Sequence Diagram

```mermaid
sequenceDiagram
    Alice->>Bob: Hello Bob
    Bob-->>Alice: Hi Alice
    Alice->>Bob: How are you?
    Bob-->>Alice: Good, thanks!
```

## 3. Pie Chart

```mermaid
pie title Language Usage
    "TypeScript" : 55
    "CSS" : 25
    "HTML" : 10
    "Other" : 10
```

## 4. Non-Mermaid Code Block (Regression Test)

This should render as normal syntax-highlighted code, not as a diagram:

```typescript
function greet(name: string): string {
  return `Hello, ${name}!`
}
```

```json
{
  "name": "onward",
  "version": "2.0.1"
}
```

# Wide Mermaid Diagram

A horizontally-wide flowchart that will exceed container width at 100% and therefore needs pan/zoom to inspect.

```mermaid
graph LR
    Start([Start]) --> A1[Load Config]
    A1 --> A2[Parse Args]
    A2 --> A3[Init Context]
    A3 --> A4[Open DB]
    A4 --> A5[Validate Schema]
    A5 --> A6[Load Cache]
    A6 --> A7[Apply Migrations]
    A7 --> A8[Start Services]
    A8 --> A9[Register Handlers]
    A9 --> A10[Warm Indexes]
    A10 --> A11[Subscribe Events]
    A11 --> A12[Open Socket]
    A12 --> A13[Handshake]
    A13 --> A14[Authenticate]
    A14 --> A15[Load Session]
    A15 --> A16[Hydrate State]
    A16 --> A17[Notify Ready]
    A17 --> End([End])
```

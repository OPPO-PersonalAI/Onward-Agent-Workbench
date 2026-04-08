<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Markdown Code Wrap Fixture

This fixture verifies inline code such as `const inlineCodeToken = "wrap-this-inline-code-token-with-extra-length-for-layout-checking-and-overflow-behavior"` can wrap when the preview toggle is enabled.

## Python Example

```python
def long_python_line():
    return "wrap-this-code-block-line-with-extra-length-for-layout-checking-and-overflow-behavior-0123456789abcdefghijklmnopqrstuvwxyz"
```

## C Example

```c
const char* example_value = "wrap-this-c-code-block-line-with-extra-length-for-layout-checking-and-overflow-behavior-0123456789abcdefghijklmnopqrstuvwxyz";
```

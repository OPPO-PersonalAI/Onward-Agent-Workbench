<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Markdown LaTeX Supported Syntax

This document records the math syntaxes that render reliably in the current Markdown preview implementation.

## Supported Delimiters

### Inline math

- `$...$`
- `\\(...\\)`

Examples:

- `$E = mc^2$`
- `\\(a^2 + b^2 = c^2\\)`

### Display math

- `$$...$$`
- `\\[...\\]`

Examples:

```markdown
$$
\\int_0^1 x^2 dx = \\frac{1}{3}
$$
```

```markdown
\\[
\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}
\\]
```

## Environment Usage

### Recommended: wrap environments inside `$$...$$`

```markdown
$$
\\begin{aligned}
f(x) &= x^2 + 1 \\\\
g(x) &= \\frac{1}{1 + e^{-x}}
\\end{aligned}
$$
```

### Compatible: bare `\\begin...\\end...` blocks

```markdown
\\begin{aligned}
f(x) &= x^2 + 1 \\\\
g(x) &= \\frac{1}{1 + e^{-x}}
\\end{aligned}
```

## Alignment With The Main Fixture

`test/dl_math_foundations.md` intentionally exercises these common patterns:

- `$...$` inline expressions
- `$$...$$` display expressions
- `\\begin{...}...\\end{...}` blocks, usually nested inside `$$...$$`

The renderer also supports `\\(...\\)` and `\\[...\\]`.

## Content Authoring Guidance

- Prefer `$...$` and `$$...$$` for readability and compatibility.
- Put complex layouts such as `aligned` or `cases` inside `$$...$$`.
- Avoid mixing too many delimiter styles inside one paragraph.

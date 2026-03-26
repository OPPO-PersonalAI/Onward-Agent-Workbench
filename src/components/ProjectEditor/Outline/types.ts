/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export enum OutlineSymbolKind {
  File,
  Module,
  Namespace,
  Package,
  Class,
  Method,
  Property,
  Field,
  Constructor,
  Enum,
  Interface,
  Function,
  Variable,
  Constant,
  String,
  Number,
  Boolean,
  Array,
  Object,
  Key,
  Null,
  EnumMember,
  Struct,
  Event,
  Operator,
  TypeParameter,
  // Markdown headings
  Heading1 = 100,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
}

export interface OutlineItem {
  name: string
  detail?: string
  kind: OutlineSymbolKind
  startLine: number       // 1-based
  startColumn: number
  endLine: number
  endColumn: number
  children: OutlineItem[]
  depth: number
}

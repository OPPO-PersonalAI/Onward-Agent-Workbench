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

export type OutlineNavigationTarget =
  | {
      kind: 'pdf-page'
      page: number
      // Full pdf.js destination (string for named dests, array for explicit
      // dests). Preserves /XYZ, /FitH, etc. so navigation is pixel-accurate.
      // The `page` field above remains the coarse anchor used for active-
      // item highlight math.
      dest?: unknown
    }
  | { kind: 'epub-href'; href: string }

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
  target?: OutlineNavigationTarget
}

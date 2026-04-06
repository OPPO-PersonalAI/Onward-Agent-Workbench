/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/// <reference lib="webworker" />
import { marked, type Tokens } from 'marked'
import katex, { type KatexOptions } from 'katex'
import markedKatex from 'marked-katex-extension'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import json from 'highlight.js/lib/languages/json'
import bash from 'highlight.js/lib/languages/bash'
import yaml from 'highlight.js/lib/languages/yaml'
import sql from 'highlight.js/lib/languages/sql'
import java from 'highlight.js/lib/languages/java'
import cpp from 'highlight.js/lib/languages/cpp'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import swift from 'highlight.js/lib/languages/swift'
import kotlin from 'highlight.js/lib/languages/kotlin'
import ruby from 'highlight.js/lib/languages/ruby'
import php from 'highlight.js/lib/languages/php'
import diff from 'highlight.js/lib/languages/diff'
import markdown from 'highlight.js/lib/languages/markdown'
import shell from 'highlight.js/lib/languages/shell'
import csharp from 'highlight.js/lib/languages/csharp'
import lua from 'highlight.js/lib/languages/lua'
import r from 'highlight.js/lib/languages/r'
import scss from 'highlight.js/lib/languages/scss'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('css', css)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('json', json)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('java', java)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('go', go)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('swift', swift)
hljs.registerLanguage('kotlin', kotlin)
hljs.registerLanguage('ruby', ruby)
hljs.registerLanguage('php', php)
hljs.registerLanguage('diff', diff)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('shell', shell)
hljs.registerLanguage('csharp', csharp)
hljs.registerLanguage('lua', lua)
hljs.registerLanguage('r', r)
hljs.registerLanguage('scss', scss)

// Register common aliases
hljs.registerAliases(['js', 'jsx'], { languageName: 'javascript' })
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' })
hljs.registerAliases(['py'], { languageName: 'python' })
hljs.registerAliases(['html', 'htm', 'vue', 'svelte'], { languageName: 'xml' })
hljs.registerAliases(['sh', 'zsh'], { languageName: 'bash' })
hljs.registerAliases(['yml'], { languageName: 'yaml' })
hljs.registerAliases(['c', 'cc', 'h', 'hpp', 'c++'], { languageName: 'cpp' })
hljs.registerAliases(['golang'], { languageName: 'go' })
hljs.registerAliases(['rs'], { languageName: 'rust' })
hljs.registerAliases(['rb'], { languageName: 'ruby' })
hljs.registerAliases(['cs', 'dotnet'], { languageName: 'csharp' })
hljs.registerAliases(['md'], { languageName: 'markdown' })
hljs.registerAliases(['jsonc', 'json5'], { languageName: 'json' })

type MarkdownRenderRequest = {
  id: number
  content: string
  rootPath: string
  baseDir: string
  imageMap?: Record<string, string>
  profile?: boolean
}

type MarkdownRenderResponse = {
  id: number
  html: string
  imagePaths: string[]
  renderDuration?: number
  contentLength?: number
}

type KatexToken = {
  type: string
  raw: string
  text: string
  displayMode: boolean
}

const KATEX_OPTIONS: KatexOptions = {
  throwOnError: false,
  strict: 'ignore',
  output: 'htmlAndMathml'
}

function renderKatex(token: KatexToken, newlineAfter = false): string {
  const html = katex.renderToString(token.text, {
    ...KATEX_OPTIONS,
    displayMode: token.displayMode
  })
  return newlineAfter ? `${html}\n` : html
}

const inlineParenRule = /^\\\(((?:\\.|[^\\\n])+?)\\\)/
const blockBracketRule = /^\\\[\n((?:\\[^]|[^\\])+?)\n\\\](?:\n|$)/
const blockEnvironmentRule = /^\\begin\{([a-zA-Z*]+)\}\n((?:\\[^]|[^\\])+?)\n\\end\{\1\}(?:\n|$)/

marked.use(markedKatex({
  ...KATEX_OPTIONS,
  nonStandard: true
}))

marked.use({
  extensions: [
    {
      name: 'inlineKatexParentheses',
      level: 'inline',
      start(src: string) {
        const index = src.indexOf('\\(')
        return index === -1 ? undefined : index
      },
      tokenizer(src: string): KatexToken | undefined {
        const match = src.match(inlineParenRule)
        if (!match) return undefined
        return {
          type: 'inlineKatexParentheses',
          raw: match[0],
          text: match[1].trim(),
          displayMode: false
        }
      },
      renderer(token: KatexToken) {
        return renderKatex(token, false)
      }
    },
    {
      name: 'blockKatexBrackets',
      level: 'block',
      start(src: string) {
        const index = src.indexOf('\\[')
        return index === -1 ? undefined : index
      },
      tokenizer(src: string): KatexToken | undefined {
        const match = src.match(blockBracketRule)
        if (!match) return undefined
        return {
          type: 'blockKatexBrackets',
          raw: match[0],
          text: match[1].trim(),
          displayMode: true
        }
      },
      renderer(token: KatexToken) {
        return renderKatex(token, true)
      }
    },
    {
      name: 'blockKatexEnvironment',
      level: 'block',
      start(src: string) {
        const index = src.indexOf('\\begin{')
        return index === -1 ? undefined : index
      },
      tokenizer(src: string): KatexToken | undefined {
        const match = src.match(blockEnvironmentRule)
        if (!match) return undefined
        return {
          type: 'blockKatexEnvironment',
          raw: match[0],
          text: match[0].trim(),
          displayMode: true
        }
      },
      renderer(token: KatexToken) {
        return renderKatex(token, true)
      }
    }
  ]
})

function renderHighlightedCodeBlock(text: string, lang?: string): string {
  const language = lang && hljs.getLanguage(lang) ? lang : undefined
  const highlighted = language
    ? hljs.highlight(text, { language }).value
    : hljs.highlightAuto(text).value
  return `<pre><code class="hljs${lang ? ` language-${lang}` : ''}">${highlighted}</code></pre>\n`
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/')
}

function buildCollapsedPath(value: string): string {
  const normalized = normalizePath(value)
  const hasDrive = /^[A-Za-z]:/.test(normalized)
  const isAbsolute = normalized.startsWith('/') || hasDrive
  const rawParts = normalized.split('/')
  let prefix = ''

  if (hasDrive) {
    prefix = rawParts.shift() || ''
  } else if (rawParts[0] === '') {
    rawParts.shift()
  }

  const parts: string[] = []
  rawParts.forEach((part) => {
    if (!part || part === '.') return
    if (part === '..') {
      if (parts.length > 0) {
        parts.pop()
      }
      return
    }
    parts.push(part)
  })

  if (prefix) {
    return `${prefix}/${parts.join('/')}`
  }

  return isAbsolute ? `/${parts.join('/')}` : parts.join('/')
}

function resolveRelativeToRoot(baseDir: string, inputPath: string): string | null {
  const normalizedInput = normalizePath(inputPath)
  if (!normalizedInput) return null
  const isRootRelative = normalizedInput.startsWith('/')
  const baseParts = isRootRelative
    ? []
    : normalizePath(baseDir).split('/').filter(Boolean)
  const rawParts = (isRootRelative ? normalizedInput.slice(1) : normalizedInput).split('/')

  const parts: string[] = [...baseParts]
  for (const part of rawParts) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
      continue
    }
    parts.push(part)
  }

  return parts.join('/')
}

function toFileUrl(path: string): string {
  const normalized = normalizePath(path)
  const withLeadingSlash = /^[A-Za-z]:/.test(normalized)
    ? `/${normalized}`
    : normalized
  return encodeURI(`file://${withLeadingSlash}`)
}

function splitUrlParts(value: string): { path: string; suffix: string } {
  const match = value.match(/^([^?#]*)(.*)$/)
  if (!match) return { path: value, suffix: '' }
  return { path: match[1], suffix: match[2] || '' }
}

function isExternalUrl(value: string): boolean {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return true
  return (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('file:') ||
    trimmed.startsWith('mailto:') ||
    trimmed.startsWith('tel:') ||
    trimmed.startsWith('sms:') ||
    trimmed.startsWith('cid:') ||
    trimmed.startsWith('xmpp:') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('//')
  )
}

function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/&[^;]+;/g, '')
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function buildHeadingId(text: string, slugCounts: Map<string, number>): string {
  const baseSlug = headingSlug(text) || 'section'
  const count = slugCounts.get(baseSlug) ?? 0
  slugCounts.set(baseSlug, count + 1)
  return count > 0 ? `${baseSlug}-${count}` : baseSlug
}

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope

ctx.addEventListener('message', (event: MessageEvent<MarkdownRenderRequest>) => {
  const payload = event.data
  if (!payload) return
  const imagePaths = new Set<string>()
  const imageMap = payload.imageMap ?? {}

  try {
    const slugCounts = new Map<string, number>()
    const resolveMarkdownUrl = (rawUrl: string, isImage: boolean): string => {
      if (isExternalUrl(rawUrl)) return rawUrl
      const { path: rawPath, suffix } = splitUrlParts(rawUrl)
      const relativePath = resolveRelativeToRoot(payload.baseDir, rawPath)
      if (!relativePath) return rawUrl

      if (isImage) {
        imagePaths.add(relativePath)
        const dataUrl = imageMap[relativePath]
        if (dataUrl) return dataUrl
      }

      const absolutePath = buildCollapsedPath(`${payload.rootPath}/${relativePath}`)
      const fileUrl = toFileUrl(absolutePath)
      return `${fileUrl}${suffix}`
    }

    const renderer = new marked.Renderer()
    renderer.code = function code(token: Tokens.Code): string {
      return renderHighlightedCodeBlock(token.text, token.lang)
    }
    renderer.heading = function heading(this: { parser: { parseInline: (tokens: Tokens.Generic[]) => string } }, token: Tokens.Heading): string {
      const id = buildHeadingId(token.text, slugCounts)
      const text = this.parser.parseInline(token.tokens)
      return `<h${token.depth} id="${id}">${text}</h${token.depth}>\n`
    }

    const shouldProfile = Boolean(payload.profile)
    const start = shouldProfile ? performance.now() : 0
    const html = marked.parse(payload.content ?? '', {
      gfm: true,
      breaks: true,
      async: false,
      renderer,
      walkTokens: (token: Tokens.Generic) => {
        if (token.type === 'image') {
          const imageToken = token as Tokens.Image
          if (imageToken.href) {
            imageToken.href = resolveMarkdownUrl(imageToken.href, true)
          }
        }
        if (token.type === 'link') {
          const linkToken = token as Tokens.Link
          if (linkToken.href) {
            linkToken.href = resolveMarkdownUrl(linkToken.href, false)
          }
        }
      }
    }) as string

    const response: MarkdownRenderResponse = {
      id: payload.id,
      html,
      imagePaths: Array.from(imagePaths),
      renderDuration: shouldProfile ? performance.now() - start : undefined,
      contentLength: shouldProfile ? (payload.content?.length ?? 0) : undefined
    }
    ctx.postMessage(response)
  } catch {
    const response: MarkdownRenderResponse = {
      id: payload.id,
      html: '',
      imagePaths: []
    }
    ctx.postMessage(response)
  }
})

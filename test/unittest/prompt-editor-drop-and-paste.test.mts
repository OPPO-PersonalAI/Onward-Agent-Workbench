/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  PROMPT_IMAGE_GC_GRACE_MS,
  applyPromptMentionCandidate,
  buildPromptContentWithImagesForSend,
  collectReferencedPromptImageBatchIds,
  computePromptEditorTextInsertion,
  createPromptImageBatchId,
  decidePromptEditorPasteAction,
  detectPromptMentionTrigger,
  extractClipboardFilePathsFromNative,
  formatPromptImageFilename,
  formatPromptImageToken,
  inferPromptAttachmentKind,
  isValidPromptImageBatchId,
  normalizePromptAttachmentExt,
  normalizePromptImageAttachments,
  parseLinuxGnomeCopiedFiles,
  parseMacOsFilenamesPlist,
  parseWindowsDropFilesBuffer,
  parseWindowsFileNameWBuffer,
  renumberPromptImageAttachmentsAfterRemove,
  renumberPromptTextAfterImageRemove,
  selectUnreferencedPromptImageBatchesForGc,
  toPromptImageFileUrl,
  type PromptImageAttachment
} from '../../src/utils/prompt-images.ts'
import {
  extractDroppedFilePaths,
  formatDroppedFilePathsForShell,
  parseFileUriList
} from '../../src/utils/terminal-file-drop.ts'
import { decideDraftPreservation } from '../../src/components/PromptNotebook/prompt-draft-preservation.ts'
import {
  clonePromptImageBatchOnDisk,
  copyFilesToPromptImageBatch,
  gcUnreferencedPromptImageBatches,
  pastePromptClipboard,
  readPromptAttachmentTextPreview,
  removePromptImageFromBatchOnDisk,
  savePngBufferToPromptImageBatch
} from '../../electron/main/prompt-image-storage.ts'

test('PEDP-01: batchId creation and validation reject traversal and malformed IDs', () => {
  const id = createPromptImageBatchId(1700000000000, 'abc12345')
  assert.ok(id.startsWith('p-'))
  assert.equal(isValidPromptImageBatchId(id), true)
  assert.equal(isValidPromptImageBatchId('p-abc123_XYZ'), true)
  assert.equal(isValidPromptImageBatchId('../p-escape'), false)
  assert.equal(isValidPromptImageBatchId('p-a/b'), false)
  assert.equal(isValidPromptImageBatchId('p-a\\b'), false)
  assert.equal(isValidPromptImageBatchId('ab'), false)
  assert.equal(isValidPromptImageBatchId(''), false)
})

test('PEDP-02: filename, mediaKind, token, and file:// URL formatting handle all file types', () => {
  assert.equal(formatPromptImageFilename(1), 'item-1.png')
  assert.equal(formatPromptImageFilename(2, '.pdf'), 'item-2.pdf')
  assert.equal(formatPromptImageFilename(3, '/tmp/demo.MP4'), 'item-3.mp4')
  assert.equal(formatPromptImageFilename(4, 'README.md'), 'item-4.md')
  assert.equal(formatPromptImageToken(1), '@1')
  assert.equal(formatPromptImageToken(2), '@2')

  assert.equal(normalizePromptAttachmentExt('.GIF'), '.gif')
  assert.equal(inferPromptAttachmentKind('photo.gif'), 'image')
  assert.equal(inferPromptAttachmentKind('clip.mp4'), 'video')
  assert.equal(inferPromptAttachmentKind('spec.pdf'), 'pdf')
  assert.equal(inferPromptAttachmentKind('index.html'), 'html')
  assert.equal(inferPromptAttachmentKind('guide.md'), 'markdown')
  assert.equal(inferPromptAttachmentKind('app.tsx'), 'code')

  assert.equal(
    toPromptImageFileUrl('/Users/alice/prompt-images/p-1234/item-1.png'),
    'file:///Users/alice/prompt-images/p-1234/item-1.png'
  )
  assert.equal(
    toPromptImageFileUrl('D:\\Users\\alice\\prompt images\\p-1234\\item-2.pdf'),
    'file:///D:/Users/alice/prompt%20images/p-1234/item-2.pdf'
  )
  assert.equal(
    toPromptImageFileUrl('/Users/alice/prompt-images/p-1234/item-1.png', 1700),
    'file:///Users/alice/prompt-images/p-1234/item-1.png?v=1700'
  )
})

test('PEDP-03: normalizePromptImageAttachments sorts, infers ext/mediaKind, and renumbers 1..N', () => {
  const raw = [
    {
      index: 5,
      batchId: 'p-valid_01',
      path: '/tmp/p-valid_01/item-5.pdf',
      width: 0,
      height: 0,
      updatedAt: 200,
      originalName: 'paper.pdf'
    },
    {
      index: 2,
      batchId: 'p-valid_01',
      path: '/tmp/p-valid_01/item-2.png',
      width: 400,
      height: 300,
      updatedAt: 100
    },
    {
      index: 1,
      batchId: '../bad',
      path: '/tmp/bad/item-1.png',
      width: 10,
      height: 10,
      updatedAt: 50
    }
  ]

  const normalized = normalizePromptImageAttachments(raw)
  assert.equal(normalized.length, 2)
  assert.equal(normalized[0].index, 1)
  assert.equal(normalized[0].ext, '.png')
  assert.equal(normalized[0].mediaKind, 'image')
  assert.equal(normalized[0].width, 400)
  assert.equal(normalized[1].index, 2)
  assert.equal(normalized[1].ext, '.pdf')
  assert.equal(normalized[1].mediaKind, 'pdf')
  assert.equal(normalized[1].originalName, 'paper.pdf')
})

test('PEDP-04: removing an attachment renumbers @k and legacy [#k] tokens and shifts mixed-ext paths', () => {
  const originalText = '看以下 @1 和 @2，再参考 [Image #3] 给出结论'
  const afterRemove1 = renumberPromptTextAfterImageRemove(originalText, 1)
  assert.equal(afterRemove1, '看以下 和 @1，再参考 @2 给出结论')

  const afterRemove2 = renumberPromptTextAfterImageRemove(originalText, 2)
  assert.equal(afterRemove2, '看以下 @1 和 ，再参考 @2 给出结论')

  const attachments: PromptImageAttachment[] = [
    {
      index: 1,
      batchId: 'p-batch_01',
      path: 'D:\\data\\prompt-images\\p-batch_01\\item-1.png',
      width: 100,
      height: 100,
      updatedAt: 1,
      ext: '.png',
      mediaKind: 'image'
    },
    {
      index: 2,
      batchId: 'p-batch_01',
      path: 'D:\\data\\prompt-images\\p-batch_01\\item-2.pdf',
      width: 0,
      height: 0,
      updatedAt: 2,
      ext: '.pdf',
      mediaKind: 'pdf'
    },
    {
      index: 3,
      batchId: 'p-batch_01',
      path: 'D:\\data\\prompt-images\\p-batch_01\\item-3.mp4',
      width: 0,
      height: 0,
      updatedAt: 3,
      ext: '.mp4',
      mediaKind: 'video'
    }
  ]

  const shifted = renumberPromptImageAttachmentsAfterRemove(attachments, 1, 999)
  assert.equal(shifted.length, 2)
  assert.equal(shifted[0].index, 1)
  assert.equal(shifted[0].path, 'D:\\data\\prompt-images\\p-batch_01\\item-1.pdf')
  assert.equal(shifted[0].ext, '.pdf')
  assert.equal(shifted[0].mediaKind, 'pdf')
  assert.equal(shifted[0].updatedAt, 999)
  assert.equal(shifted[1].index, 2)
  assert.equal(shifted[1].path, 'D:\\data\\prompt-images\\p-batch_01\\item-2.mp4')
  assert.equal(shifted[1].ext, '.mp4')
  assert.equal(shifted[1].mediaKind, 'video')
})

test('PEDP-05: buildPromptContentWithImagesForSend resolves [#k] / [Image #k] and appends unreferenced attachments', () => {
  const images: PromptImageAttachment[] = [
    {
      index: 1,
      batchId: 'p-batch_01',
      path: '/tmp/prompt-images/p-batch_01/item-1.png',
      width: 120,
      height: 80,
      updatedAt: 1,
      ext: '.png',
      mediaKind: 'image'
    },
    {
      index: 2,
      batchId: 'p-batch_01',
      path: '/tmp/prompt-images/p-batch_01/item-2.pdf',
      width: 0,
      height: 0,
      updatedAt: 2,
      ext: '.pdf',
      mediaKind: 'pdf'
    }
  ]

  // Case 1: Explicit @1 (and CJK-adjacent @1 via unicode escapes), unreferenced #2 is appended at the end
  const mixed = buildPromptContentWithImagesForSend('Check @1 bug in screenshot', images, 'darwin')
  assert.equal(
    mixed,
    'Check /tmp/prompt-images/p-batch_01/item-1.png bug in screenshot /tmp/prompt-images/p-batch_01/item-2.pdf'
  )

  const cjkPrefix = '\u770b\u4ee5\u4e0b'
  const cjkMid = '\u56fe\u7247\u91cc\u7684bug\uff0c\u5bf9\u6bd4'
  const cjkSuffix = '\u6587\u6863'
  const cjkAdjacent = buildPromptContentWithImagesForSend(`${cjkPrefix}@1${cjkMid}@2${cjkSuffix}`, images, 'darwin')
  assert.equal(
    cjkAdjacent,
    `${cjkPrefix} /tmp/prompt-images/p-batch_01/item-1.png ${cjkMid} /tmp/prompt-images/p-batch_01/item-2.pdf ${cjkSuffix}`
  )

  // Email addresses must NOT be mistaken for @k tokens
  const withEmail = buildPromptContentWithImagesForSend('Send mail to user@1.com and check @1', images, 'darwin')
  assert.equal(
    withEmail,
    'Send mail to user@1.com and check /tmp/prompt-images/p-batch_01/item-1.png /tmp/prompt-images/p-batch_01/item-2.pdf'
  )

  // Case 2: No explicit tokens -> all items appended in order
  const implicitAll = buildPromptContentWithImagesForSend('Analyze both files please', images, 'darwin')
  assert.equal(
    implicitAll,
    'Analyze both files please /tmp/prompt-images/p-batch_01/item-1.png /tmp/prompt-images/p-batch_01/item-2.pdf'
  )

  // Case 3: Attachment-only prompt (empty text)
  const imageOnly = buildPromptContentWithImagesForSend('   ', images, 'darwin')
  assert.equal(
    imageOnly,
    '/tmp/prompt-images/p-batch_01/item-1.png /tmp/prompt-images/p-batch_01/item-2.pdf'
  )

  // Case 4: Partial selection send (appendUnreferenced: false) resolves @1 without appending #2
  const partialSelection = buildPromptContentWithImagesForSend(
    'Inspect @1 only',
    images,
    'darwin',
    undefined,
    { appendUnreferenced: false }
  )
  assert.equal(partialSelection, 'Inspect /tmp/prompt-images/p-batch_01/item-1.png only')

  // Case 5: Cross-platform shell escaping (Windows PowerShell vs CMD vs macOS POSIX)
  const winImages: PromptImageAttachment[] = [
    {
      index: 1,
      batchId: 'p-win_01',
      path: "D:\\Users\\Alice's PC\\AppData\\Roaming\\Onward\\prompt-images\\p-win_01\\item-1.png",
      width: 100,
      height: 100,
      updatedAt: 1,
      ext: '.png',
      mediaKind: 'image'
    }
  ]
  const winPs = buildPromptContentWithImagesForSend('Inspect @1', winImages, 'win32', 'powershell')
  assert.equal(
    winPs,
    "Inspect 'D:\\Users\\Alice''s PC\\AppData\\Roaming\\Onward\\prompt-images\\p-win_01\\item-1.png'"
  )
  const winCmd = buildPromptContentWithImagesForSend('Inspect @1', winImages, 'win32', 'cmd')
  assert.equal(
    winCmd,
    'Inspect "D:\\Users\\Alice\'s PC\\AppData\\Roaming\\Onward\\prompt-images\\p-win_01\\item-1.png"'
  )
})

test('PEDP-06: decidePromptEditorPasteAction enforces Files > Pure Image > Native-Probe > Text priority', () => {
  assert.deepEqual(
    decidePromptEditorPasteAction({
      droppedFilePaths: ['/Users/alice/report.pdf', '/Users/alice/demo.mp4'],
      clipboardText: 'report.pdf',
      hasImage: false,
      hasFilesType: true
    }),
    { kind: 'files', paths: ['/Users/alice/report.pdf', '/Users/alice/demo.mp4'] }
  )

  assert.deepEqual(
    decidePromptEditorPasteAction({
      droppedFilePaths: [],
      clipboardText: '',
      hasImage: true,
      hasFilesType: true
    }),
    { kind: 'image' }
  )

  // macOS Finder / Windows Explorer non-image file or folder copy where DataTransfer.files
  // is empty in Chromium but types includes 'Files' (and Finder sets text/plain to basename)
  assert.deepEqual(
    decidePromptEditorPasteAction({
      droppedFilePaths: [],
      clipboardText: 'report.pdf',
      hasImage: false,
      hasFilesType: true
    }),
    { kind: 'native-probe' }
  )

  // Rich text copy from Word/web with both text/plain and image preview (no 'Files' type) pastes as text
  assert.deepEqual(
    decidePromptEditorPasteAction({
      droppedFilePaths: [],
      clipboardText: 'Hello world',
      hasImage: true,
      hasFilesType: false
    }),
    { kind: 'text', text: 'Hello world' }
  )
})

test('PEDP-07: computePromptEditorTextInsertion inserts at selection or appends when unfocused', () => {
  const mid = computePromptEditorTextInsertion('hello world', { start: 6, end: 6 }, '/tmp/a.txt ')
  assert.equal(mid.nextText, 'hello /tmp/a.txt world')
  assert.equal(mid.nextCaret, 17)

  const replaced = computePromptEditorTextInsertion('hello world', { start: 6, end: 11 }, '[#1]')
  assert.equal(replaced.nextText, 'hello [#1]')
  assert.equal(replaced.nextCaret, 10)

  const appended = computePromptEditorTextInsertion('check this: ', null, '/tmp/b.txt ')
  assert.equal(appended.nextText, 'check this: /tmp/b.txt ')
  assert.equal(appended.nextCaret, appended.nextText.length)
})

test('PEDP-08: decideDraftPreservation preserves attachment-only drafts and attachment edits', () => {
  const sampleImagePath = '/tmp/p-batch_99/item-1.pdf'

  const imageOnlyDecision = decideDraftPreservation({
    normalizedContent: '',
    title: '',
    imagePaths: [sampleImagePath],
    editingOriginal: null
  })
  assert.deepEqual(imageOnlyDecision, { preserve: true, reason: 'draft-preserved' })

  const untouchedEdit = decideDraftPreservation({
    normalizedContent: 'hello',
    title: 't',
    imagePaths: [sampleImagePath],
    editingOriginal: {
      normalizedContent: 'hello',
      title: 't',
      imagePaths: [sampleImagePath]
    }
  })
  assert.deepEqual(untouchedEdit, { preserve: false, reason: 'unchanged-from-source' })

  const modifiedImagesEdit = decideDraftPreservation({
    normalizedContent: 'hello',
    title: 't',
    imagePaths: [],
    editingOriginal: {
      normalizedContent: 'hello',
      title: 't',
      imagePaths: [sampleImagePath]
    }
  })
  assert.deepEqual(modifiedImagesEdit, { preserve: true, reason: 'draft-preserved' })
})

test('PEDP-09: disk storage saves mixed files/images, separates directories, renumbers on remove, previews text, and GCs', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onward-prompt-img-unit-'))
  const sourceFixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onward-prompt-src-unit-'))
  try {
    const batchA = 'p-unit_batch_a'
    const batchB = 'p-unit_batch_b'
    const batchOrphanOld = 'p-unit_orphan_old'
    const batchOrphanFresh = 'p-unit_orphan_fresh'

    const fakePng1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01])
    const srcPdfPath = path.join(sourceFixturesDir, 'spec.pdf')
    const srcMdPath = path.join(sourceFixturesDir, 'notes.md')
    const srcSubDir = path.join(sourceFixturesDir, 'my-folder')
    fs.writeFileSync(srcPdfPath, Buffer.from('%PDF-1.7 sample'))
    fs.writeFileSync(srcMdPath, '# Hello Markdown\nLine 2', 'utf8')
    fs.mkdirSync(srcSubDir, { recursive: true })

    // 1. Save a pasted PNG as #1 -> item-1.png
    const img1 = savePngBufferToPromptImageBatch(batchA, 1, fakePng1, { width: 10, height: 20 }, tempRoot)
    assert.ok(img1.path.endsWith('item-1.png'))
    assert.equal(fs.existsSync(img1.path), true)

    // 2. Paste local files (spec.pdf, notes.md) + a folder (my-folder) via pastePromptClipboard
    const pasteRes = pastePromptClipboard(batchA, 2, tempRoot, {
      filePaths: [srcPdfPath, srcMdPath, srcSubDir]
    })
    assert.equal(pasteRes.ok, true)
    assert.equal(pasteRes.kind, 'files')
    assert.equal(pasteRes.attachments?.length, 2)
    assert.deepEqual(pasteRes.directoryPaths, [srcSubDir])

    const item2Pdf = pasteRes.attachments![0]
    const item3Md = pasteRes.attachments![1]
    assert.equal(item2Pdf.index, 2)
    assert.ok(item2Pdf.path.endsWith('item-2.pdf'))
    assert.equal(item2Pdf.mediaKind, 'pdf')
    assert.equal(item2Pdf.originalName, 'spec.pdf')

    assert.equal(item3Md.index, 3)
    assert.ok(item3Md.path.endsWith('item-3.md'))
    assert.equal(item3Md.mediaKind, 'markdown')
    assert.equal(item3Md.originalName, 'notes.md')

    // 3. Preview text content of item-3.md and reject path outside tempRoot
    const previewOk = readPromptAttachmentTextPreview(item3Md.path, tempRoot)
    assert.equal(previewOk.ok, true)
    assert.equal(previewOk.content, '# Hello Markdown\nLine 2')

    const previewOutside = readPromptAttachmentTextPreview(srcMdPath, tempRoot)
    assert.equal(previewOutside.ok, false)
    assert.equal(previewOutside.error, 'outside-prompt-images-root')

    // 4. Remove #1 on disk -> #2 (item-2.pdf) becomes item-1.pdf, #3 (item-3.md) becomes item-2.md
    const remaining = removePromptImageFromBatchOnDisk(batchA, 1, [img1, item2Pdf, item3Md], tempRoot)
    assert.equal(remaining.length, 2)
    assert.equal(remaining[0].index, 1)
    assert.ok(remaining[0].path.endsWith('item-1.pdf'))
    assert.equal(remaining[0].mediaKind, 'pdf')
    assert.equal(fs.existsSync(remaining[0].path), true)
    assert.equal(remaining[1].index, 2)
    assert.ok(remaining[1].path.endsWith('item-2.md'))
    assert.equal(remaining[1].mediaKind, 'markdown')
    assert.equal(fs.readFileSync(remaining[1].path, 'utf8'), '# Hello Markdown\nLine 2')

    // 5. Clone batchA -> batchB preserving extensions
    const cloned = clonePromptImageBatchOnDisk(batchA, batchB, remaining, tempRoot)
    assert.equal(cloned.length, 2)
    assert.equal(cloned[0].batchId, batchB)
    assert.ok(cloned[0].path.endsWith('item-1.pdf'))
    assert.ok(cloned[1].path.endsWith('item-2.md'))
    assert.equal(fs.readFileSync(cloned[1].path, 'utf8'), '# Hello Markdown\nLine 2')

    // 6. GC unreferenced batches respecting grace window
    const orphanOldImg = savePngBufferToPromptImageBatch(batchOrphanOld, 1, fakePng1, { width: 10, height: 10 }, tempRoot)
    savePngBufferToPromptImageBatch(batchOrphanFresh, 1, fakePng1, { width: 10, height: 10 }, tempRoot)

    const now = Date.now()
    const oldTime = new Date(now - PROMPT_IMAGE_GC_GRACE_MS - 10_000)
    fs.utimesSync(orphanOldImg.path, oldTime, oldTime)
    fs.utimesSync(path.join(tempRoot, batchOrphanOld), oldTime, oldTime)

    const state = {
      globalPrompts: [{ images: [{ batchId: batchA }] }],
      tabs: [
        {
          localPrompts: [],
          editorDraft: { batchId: batchB }
        }
      ]
    }

    const referenced = collectReferencedPromptImageBatchIds(state)
    assert.equal(referenced.has(batchA), true)
    assert.equal(referenced.has(batchB), true)
    assert.equal(referenced.has(batchOrphanOld), false)

    const toDelete = selectUnreferencedPromptImageBatchesForGc(
      [
        { batchId: batchA, mtimeMs: oldTime.getTime() },
        { batchId: batchB, mtimeMs: oldTime.getTime() },
        { batchId: batchOrphanOld, mtimeMs: oldTime.getTime() },
        { batchId: batchOrphanFresh, mtimeMs: now }
      ],
      referenced,
      now
    )
    assert.deepEqual(toDelete, [batchOrphanOld])

    const gcResult = gcUnreferencedPromptImageBatches(state, {
      customRootDir: tempRoot,
      nowMs: now,
      gracePeriodMs: PROMPT_IMAGE_GC_GRACE_MS
    })
    assert.deepEqual(gcResult.deletedBatchIds, [batchOrphanOld])
    assert.equal(fs.existsSync(path.join(tempRoot, batchOrphanOld)), false)
    assert.equal(fs.existsSync(path.join(tempRoot, batchOrphanFresh)), true)
    assert.equal(fs.existsSync(path.join(tempRoot, batchA)), true)
    assert.equal(fs.existsSync(path.join(tempRoot, batchB)), true)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    fs.rmSync(sourceFixturesDir, { recursive: true, force: true })
  }
})

test('PEDP-12: detectPromptMentionTrigger and applyPromptMentionCandidate support @ popup and filter', () => {
  const images: PromptImageAttachment[] = [
    {
      index: 1,
      batchId: 'p-batch_01',
      path: '/tmp/prompt-images/p-batch_01/item-1.png',
      width: 120,
      height: 80,
      updatedAt: 1,
      ext: '.png',
      mediaKind: 'image'
    },
    {
      index: 2,
      batchId: 'p-batch_01',
      path: '/tmp/prompt-images/p-batch_01/item-2.pdf',
      width: 0,
      height: 0,
      updatedAt: 2,
      ext: '.pdf',
      mediaKind: 'pdf',
      originalName: 'spec.pdf'
    }
  ]

  const cjkPrefix = '\u770b\u4ee5\u4e0b'
  const cjkSuffix = '\u56fe\u7247\u91cc\u7684bug'

  // Empty attachments -> never triggers
  assert.equal(detectPromptMentionTrigger(`${cjkPrefix} @`, 5, []), null)

  // Email address -> does not trigger
  assert.equal(detectPromptMentionTrigger('contact foo@', 12, images), null)
  assert.equal(detectPromptMentionTrigger('contact foo@1', 13, images), null)

  // Valid trigger after space or CJK character
  const trigAll = detectPromptMentionTrigger(`${cjkPrefix} @`, 5, images)
  assert.ok(trigAll)
  assert.equal(trigAll.startOffset, 4)
  assert.equal(trigAll.endOffset, 5)
  assert.equal(trigAll.query, '')
  assert.equal(trigAll.candidates.length, 2)

  const trigCjk = detectPromptMentionTrigger(`${cjkPrefix}@1`, 5, images)
  assert.ok(trigCjk)
  assert.equal(trigCjk.startOffset, 3)
  assert.equal(trigCjk.endOffset, 5)
  assert.equal(trigCjk.query, '1')
  assert.equal(trigCjk.candidates.length, 1)
  assert.equal(trigCjk.candidates[0].index, 1)

  // Applying candidate replaces @<query> with @<index> + trailing space
  const applied = applyPromptMentionCandidate(`${cjkPrefix} @${cjkSuffix}`, {
    startOffset: 4,
    endOffset: 5
  }, 1)
  assert.equal(applied.nextText, `${cjkPrefix} @1 ${cjkSuffix}`)
  assert.equal(applied.nextCaret, 7)

  // When a space already follows the trigger range, do not duplicate spaces
  const appliedWithExistingSpace = applyPromptMentionCandidate(`${cjkPrefix} @1 ${cjkSuffix}`, {
    startOffset: 4,
    endOffset: 6
  }, 2)
  assert.equal(appliedWithExistingSpace.nextText, `${cjkPrefix} @2 ${cjkSuffix}`)
  assert.equal(appliedWithExistingSpace.nextCaret, 7)
})

test('PEDP-10: cross-platform native clipboard parsers extract copied files on macOS, Windows, and Linux', () => {
  // 1. macOS NSFilenamesPboardType plist XML (with XML entities)
  const macPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
  <string>/Users/alice/Documents/spec &amp; design.pdf</string>
  <string>/Users/alice/Movies/demo.mp4</string>
</array>
</plist>`
  assert.deepEqual(parseMacOsFilenamesPlist(macPlist), [
    '/Users/alice/Documents/spec & design.pdf',
    '/Users/alice/Movies/demo.mp4'
  ])

  // 2. Windows CF_HDROP (DROPFILES struct: 20-byte header + UTF-16LE double-null-terminated list)
  const winPaths = ['C:\\Users\\Alice\\Desktop\\report.pdf', 'D:\\Projects\\Onward\\README.md']
  const joinedUtf16 = Buffer.from(`${winPaths.join('\0')}\0\0`, 'utf16le')
  const hdropHeader = Buffer.alloc(20)
  hdropHeader.writeUInt32LE(20, 0) // pFiles = 20
  hdropHeader.writeUInt32LE(1, 16) // fWide = 1 (UTF-16LE)
  const cfHdropBuf = Buffer.concat([hdropHeader, joinedUtf16])
  assert.deepEqual(parseWindowsDropFilesBuffer(cfHdropBuf), winPaths)

  // Windows CF_HDROP ANSI (fWide = 0)
  const joinedAnsi = Buffer.from('C:\\temp\\a.txt\0C:\\temp\\b.png\0\0', 'latin1')
  const ansiHeader = Buffer.alloc(20)
  ansiHeader.writeUInt32LE(20, 0)
  ansiHeader.writeUInt32LE(0, 16)
  assert.deepEqual(parseWindowsDropFilesBuffer(Buffer.concat([ansiHeader, joinedAnsi])), [
    'C:\\temp\\a.txt',
    'C:\\temp\\b.png'
  ])

  // Windows FileNameW buffer
  const fileNameWBuf = Buffer.from('D:\\Work\\diagram.png\0', 'utf16le')
  assert.deepEqual(parseWindowsFileNameWBuffer(fileNameWBuf), ['D:\\Work\\diagram.png'])

  // 3. Linux GNOME copied files
  const gnomePayload = 'copy\nfile:///home/alice/docs/guide%20v2.pdf\nfile:///home/alice/code/main.rs\n'
  assert.deepEqual(parseLinuxGnomeCopiedFiles(gnomePayload), [
    '/home/alice/docs/guide v2.pdf',
    '/home/alice/code/main.rs'
  ])

  // 4. Unified extractClipboardFilePathsFromNative across darwin / win32 / linux
  const macExtracted = extractClipboardFilePathsFromNative(
    {
      availableFormats: () => ['NSFilenamesPboardType', 'public.utf8-plain-text'],
      readText: (fmt) => (fmt === 'NSFilenamesPboardType' ? macPlist : ''),
      readBuffer: () => new Uint8Array()
    },
    'darwin'
  )
  assert.deepEqual(macExtracted, [
    '/Users/alice/Documents/spec & design.pdf',
    '/Users/alice/Movies/demo.mp4'
  ])

  const winExtracted = extractClipboardFilePathsFromNative(
    {
      availableFormats: () => ['CF_HDROP', 'FileNameW'],
      readText: () => '',
      readBuffer: (fmt) => (fmt === 'CF_HDROP' ? cfHdropBuf : new Uint8Array())
    },
    'win32'
  )
  assert.deepEqual(winExtracted, winPaths)

  const linuxExtracted = extractClipboardFilePathsFromNative(
    {
      availableFormats: () => ['x-special/gnome-copied-files'],
      readText: (fmt) => (fmt === 'x-special/gnome-copied-files' ? gnomePayload : ''),
      readBuffer: () => new Uint8Array()
    },
    'linux'
  )
  assert.deepEqual(linuxExtracted, [
    '/home/alice/docs/guide v2.pdf',
    '/home/alice/code/main.rs'
  ])
})

test('PEDP-11: cross-platform file drag-and-drop extracts and escapes paths on Windows, macOS, and Linux', () => {
  // Windows file:// URI list (local drive + UNC share)
  const winUris = 'file:///C:/Users/Alice/My%20Project/src/index.ts\r\nfile://server/share/folder%20name/doc.pdf\r\n'
  const winParsed = parseFileUriList(winUris, 'win32')
  assert.deepEqual(winParsed, [
    'C:\\Users\\Alice\\My Project\\src\\index.ts',
    '\\\\server\\share\\folder name\\doc.pdf'
  ])
  assert.equal(
    formatDroppedFilePathsForShell(winParsed, 'win32', 'powershell'),
    "'C:\\Users\\Alice\\My Project\\src\\index.ts' '\\\\server\\share\\folder name\\doc.pdf' "
  )

  // macOS file:// URI list with spaces and apostrophes
  const macUris = "file:///Users/alice/My%20Docs/Bob's%20Spec.pdf\n"
  const macExtracted = extractDroppedFilePaths(null, undefined, {
    uriListText: macUris,
    platform: 'darwin'
  })
  assert.deepEqual(macExtracted, ["/Users/alice/My Docs/Bob's Spec.pdf"])
  assert.equal(
    formatDroppedFilePathsForShell(macExtracted, 'darwin'),
    "'/Users/alice/My Docs/Bob'\\''s Spec.pdf' "
  )
})

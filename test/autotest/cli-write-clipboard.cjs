// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
const { app, clipboard, nativeImage } = require('electron')
app.whenReady().then(() => {
  try {
    const image = nativeImage.createFromPath(process.argv[2])
    if (image.isEmpty()) throw new Error('Fixture image did not decode')
    clipboard.write({ image, text: 'image-text-flavor-must-not-be-pasted' })
    // X11 clipboard ownership lasts only while the writer is alive.
    const deadline = setTimeout(() => app.exit(1), 30000)
    process.stdin.resume()
    process.stdin.once('end', () => { clearTimeout(deadline); app.exit(0) })
    process.stdout.write('CLIPBOARD_READY\n')
  } catch (error) { console.error(error); app.exit(1) }
})

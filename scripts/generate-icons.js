/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Icon generation script
 * Convert SVG to PNG in various sizes for compatibility with different platforms
 *
 * Usage: node scripts/generate-icons.js
 * Dependencies: rsvg-convert (brew install librsvg)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Icon size configuration
const ICON_SIZES = {
  // macOS required size
  macos: [16, 32, 64, 128, 256, 512, 1024],
  // Windows required size
  windows: [16, 24, 32, 48, 64, 128, 256],
  // Linux required size
  linux: [16, 22, 24, 32, 48, 64, 128, 256, 512]
};

// Get all unique dimensions
const ALL_SIZES = [...new Set([
  ...ICON_SIZES.macos,
  ...ICON_SIZES.windows,
  ...ICON_SIZES.linux
])].sort((a, b) => a - b);

const RESOURCES_DIR = path.join(__dirname, '..', 'resources');
const ICONS_DIR = path.join(RESOURCES_DIR, 'icons');
const SVG_PATH = path.join(RESOURCES_DIR, 'icon.svg');

function generateIcons() {
  console.log('Generating icons...\n');

  // Check if rsvg-convert is available
  try {
    execSync('which rsvg-convert', { stdio: 'pipe' });
  } catch {
    console.error('Error: rsvg-convert is required');
    console.error('   macOS: brew install librsvg');
    console.error('   Ubuntu: apt install librsvg2-bin');
    process.exit(1);
  }

  // Make sure the output directory exists
  if (!fs.existsSync(ICONS_DIR)) {
    fs.mkdirSync(ICONS_DIR, { recursive: true });
  }

  // Create platform subdirectory
  const platforms = ['macos', 'windows', 'linux'];
  for (const platform of platforms) {
    const platformDir = path.join(ICONS_DIR, platform);
    if (!fs.existsSync(platformDir)) {
      fs.mkdirSync(platformDir, { recursive: true });
    }
  }

  // Generate PNGs of various sizes
  console.log('Generating PNG icons:');
  for (const size of ALL_SIZES) {
    const outputPath = path.join(ICONS_DIR, `icon-${size}x${size}.png`);

    execSync(`rsvg-convert -w ${size} -h ${size} "${SVG_PATH}" -o "${outputPath}"`, {
      stdio: 'pipe'
    });

    console.log(`   ✓ ${size}x${size}`);
  }

  // Copy to each platform directory
  console.log('\nCopying files into platform directories:');

  // macOS
  console.log('   macOS:');
  for (const size of ICON_SIZES.macos) {
    const src = path.join(ICONS_DIR, `icon-${size}x${size}.png`);
    const dest = path.join(ICONS_DIR, 'macos', `icon_${size}x${size}.png`);
    fs.copyFileSync(src, dest);

    // macOS also requires @2x version
    if (size <= 512) {
      const size2x = size * 2;
      const src2x = path.join(ICONS_DIR, `icon-${size2x}x${size2x}.png`);
      if (fs.existsSync(src2x)) {
        const dest2x = path.join(ICONS_DIR, 'macos', `icon_${size}x${size}@2x.png`);
        fs.copyFileSync(src2x, dest2x);
      }
    }
  }
  console.log('      ✓ Done');

  // Windows
  console.log('   Windows:');
  for (const size of ICON_SIZES.windows) {
    const src = path.join(ICONS_DIR, `icon-${size}x${size}.png`);
    const dest = path.join(ICONS_DIR, 'windows', `icon-${size}.png`);
    fs.copyFileSync(src, dest);
  }
  console.log('      ✓ Done');

  // Linux
  console.log('   Linux:');
  for (const size of ICON_SIZES.linux) {
    const src = path.join(ICONS_DIR, `icon-${size}x${size}.png`);
    const dest = path.join(ICONS_DIR, 'linux', `${size}x${size}.png`);
    fs.copyFileSync(src, dest);
  }
  console.log('      ✓ Done');

  // Generate favicon
  console.log('\nGenerating favicon:');
  const faviconPath = path.join(ICONS_DIR, 'favicon.png');
  execSync(`rsvg-convert -w 32 -h 32 "${SVG_PATH}" -o "${faviconPath}"`, {
    stdio: 'pipe'
  });
  console.log('   ✓ favicon.png (32x32)');

  console.log('\nIcon generation completed.');
  console.log(`   Output directory: ${ICONS_DIR}`);

  // Output summary
  console.log('\nGenerated file summary:');
  console.log(`   - PNG icons: ${ALL_SIZES.length} sizes`);
  console.log(`   - macOS: ${ICON_SIZES.macos.length} sizes (including @2x)`);
  console.log(`   - Windows: ${ICON_SIZES.windows.length} sizes`);
  console.log(`   - Linux: ${ICON_SIZES.linux.length} sizes`);

  // Generate macOS .icns files
  console.log('\nGenerating macOS .icns:');
  try {
    const iconsetDir = path.join(ICONS_DIR, 'icon.iconset');
    if (!fs.existsSync(iconsetDir)) {
      fs.mkdirSync(iconsetDir, { recursive: true });
    }

    // Copy the required icons to the iconset directory
    const macosDir = path.join(ICONS_DIR, 'macos');
    const iconsetFiles = [
      'icon_16x16.png', 'icon_16x16@2x.png',
      'icon_32x32.png', 'icon_32x32@2x.png',
      'icon_128x128.png', 'icon_128x128@2x.png',
      'icon_256x256.png', 'icon_256x256@2x.png',
      'icon_512x512.png', 'icon_512x512@2x.png'
    ];

    for (const file of iconsetFiles) {
      const src = path.join(macosDir, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(iconsetDir, file));
      }
    }

    // Use iconutil to generate .icns
    execSync(`iconutil -c icns "${iconsetDir}" -o "${path.join(RESOURCES_DIR, 'icon.icns')}"`, {
      stdio: 'pipe'
    });

    // Clean up temporary directory
    fs.rmSync(iconsetDir, { recursive: true });
    console.log('   ✓ icon.icns generated successfully');
  } catch (err) {
    console.log('   ⚠ Skipped .icns generation (macOS only)');
  }

  // Generate Windows .ico file
  console.log('\nGenerating Windows .ico:');
  try {
    execSync('which magick', { stdio: 'pipe' });
    const windowsDir = path.join(ICONS_DIR, 'windows');
    const icoSizes = ['icon-16.png', 'icon-24.png', 'icon-32.png', 'icon-48.png', 'icon-64.png', 'icon-128.png', 'icon-256.png'];
    const icoInputs = icoSizes.map(f => `"${path.join(windowsDir, f)}"`).join(' ');

    execSync(`magick ${icoInputs} "${path.join(RESOURCES_DIR, 'icon.ico')}"`, {
      stdio: 'pipe'
    });
    console.log('   ✓ icon.ico generated successfully');
  } catch (err) {
    console.log('   ⚠ Skipped .ico generation (requires ImageMagick: brew install imagemagick)');
  }

  console.log('\nAll icon assets are ready.');
}

generateIcons();

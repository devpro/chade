// Saves frames of a recorded lab as one PNG, a contact sheet, to check a video before publishing it.
// It plays the video in the Chromium of sidelab's Playwright, since the ffmpeg Playwright ships has no image filters and ffmpeg may not be installed.
//
// node labs/video_frames.mjs <video.webm> <out.png> <from seconds> <to seconds> <count> [columns]
// One frame at full size: node labs/video_frames.mjs ~/chade-demo.webm frame.png 190 190 1 1

import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [video, out, from, to, count, columns] = process.argv.slice(2)
if (!video || !out || from === undefined || to === undefined || !count) {
  console.error('usage: node labs/video_frames.mjs <video.webm> <out.png> <from seconds> <to seconds> <count> [columns]')
  process.exit(2)
}

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sidelabDir = path.resolve(repoDir, process.env.SIDELAB_DIR ?? '../sidelab')
const { chromium } = createRequire(path.join(sidelabDir, 'package.json'))('playwright')

const n = Number(count)
const cols = Number(columns ?? Math.min(n, 4))
const rows = Math.ceil(n / cols)
const width = 1920
const height = 1080
const cell = { width: width / cols, height: height / cols }

// A page opened from a file reads a video from a file, which a page made with setContent may not.
const workDir = mkdtempSync(path.join(tmpdir(), 'video-frames-'))
const page = path.join(workDir, 'frames.html')
writeFileSync(page, `<body style="margin:0;background:#000">
<video id="v" src="${pathToFileURL(path.resolve(video))}" muted preload="auto" style="display:none"></video>
<canvas id="c" width="${width}" height="${cell.height * rows}"></canvas></body>`)

const browser = await chromium.launch()
try {
  const tab = await browser.newPage({ viewport: { width, height: cell.height * rows } })
  await tab.goto(pathToFileURL(page).href)
  await tab.evaluate(async ({ from, to, n, cols, cell }) => {
    const v = document.getElementById('v')
    const c = document.getElementById('c').getContext('2d')
    await new Promise((resolve, reject) => {
      if (v.readyState >= 1) resolve()
      v.addEventListener('loadedmetadata', resolve, { once: true })
      v.addEventListener('error', () => reject(new Error('the video does not load')), { once: true })
    })
    for (let i = 0; i < n; i++) {
      const at = n === 1 ? from : from + (to - from) * i / (n - 1)
      v.currentTime = Math.min(at, v.duration)
      await new Promise((resolve) => v.addEventListener('seeked', resolve, { once: true }))
      const x = (i % cols) * cell.width
      const y = Math.floor(i / cols) * cell.height
      c.drawImage(v, x, y, cell.width, cell.height)
      c.fillStyle = '#ff0'
      c.font = '18px sans-serif'
      c.fillText(`${v.currentTime.toFixed(0)}s`, x + 6, y + 22)
    }
  }, { from: Number(from), to: Number(to), n, cols, cell })
  await tab.locator('#c').screenshot({ path: out, timeout: 60000 })
  console.log(out)
} finally {
  await browser.close()
  rmSync(workDir, { recursive: true, force: true })
}

import type { BrowserWindow } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { SCREENS, type ScreenId } from '@shared/nav'
import { app } from 'electron'
import { emit } from './ipcx'
import { setTheme } from './theme'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Screenshot mode (CLAUDOCK_SHOT=1, driven by scripts/shot.mjs): visits every screen in light then dark through the
 * normal `system:navigate` / `system:theme` events, saves `<dir>/<theme>-<screen>.png`, prints renderer console errors
 * as `CONSOLE_ERROR ...` and exits 0 (clean) or 1 (errors).
 */
export async function runShots(win: BrowserWindow, opts: { dir: string; only: string[] }): Promise<void> {
  const errors: string[] = []
  win.webContents.on('console-message', (details) => {
    const d = details as unknown as { level: string; message: string; sourceId?: string; lineNumber?: number }
    if (d.level === 'error') {
      const line = `CONSOLE_ERROR ${d.message} (${d.sourceId ?? ''}:${d.lineNumber ?? ''})`
      errors.push(line)
      console.log(line)
    }
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    errors.push(`RENDERER_GONE ${details.reason}`)
    console.log(`RENDERER_GONE ${details.reason}`)
  })

  const js = <T,>(code: string): Promise<T> => win.webContents.executeJavaScript(code) as Promise<T>

  async function settle(): Promise<void> {
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) {
      const busy = await js<number>(`document.querySelectorAll('.spinner, [aria-busy="true"]').length`)
      if (busy === 0) break
      await sleep(100)
    }
    await sleep(450)
  }

  await fsp.mkdir(opts.dir, { recursive: true })
  const screens = SCREENS.filter((s) => opts.only.length === 0 || opts.only.includes(s.id))

  try {
    // wait for the shell
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline && !(await js<boolean>(`!!document.querySelector('[data-app-ready]')`))) await sleep(100)

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(theme, false)
      await sleep(200)
      for (const s of screens) {
        emit('system:navigate', { screen: s.id as ScreenId })
        await sleep(150)
        await settle()
        const img = await win.webContents.capturePage()
        const file = path.join(opts.dir, `${theme}-${s.id}.png`)
        await fsp.writeFile(file, img.toPNG())
        console.log(`SHOT ${file} ${img.getSize().width}x${img.getSize().height}`)
      }
      if (opts.only.length === 0 || opts.only.includes('palette')) {
        emit('system:openPalette', null)
        await sleep(500)
        const img = await win.webContents.capturePage()
        const file = path.join(opts.dir, `${theme}-palette.png`)
        await fsp.writeFile(file, img.toPNG())
        console.log(`SHOT ${file} ${img.getSize().width}x${img.getSize().height}`)
        await js(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))`)
        await sleep(200)
      }
    }
  } catch (e) {
    errors.push(`SHOT_FAILED ${(e as Error).message}`)
    console.log(`SHOT_FAILED ${(e as Error).message}`)
  }

  console.log(errors.length ? `SHOT_DONE with ${errors.length} error(s)` : 'SHOT_DONE ok')
  app.exit(errors.length ? 1 : 0)
}

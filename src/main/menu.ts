import { Menu, type MenuItem, type MenuItemConstructorOptions } from 'electron'
import { THEME_PREFS, type ThemePref } from '@shared/types'
import { installKind } from './paths'
import { menuBarShown, openAtLoginShown, setMenuBar } from './menubar'
import { currentTheme, setTheme } from './theme'

const LABEL: Record<ThemePref, string> = { system: 'System', light: 'Light', dark: 'Dark' }

export function buildMenu(): void {
  const mac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: 'Theme',
          submenu: THEME_PREFS.map(
            (t): MenuItemConstructorOptions => ({
              label: LABEL[t],
              type: 'radio',
              checked: currentTheme() === t,
              click: () => void setTheme(t)
            })
          )
        },
        {
          label: mac ? 'Show in Menu Bar' : 'Show in Tray',
          type: 'checkbox',
          checked: menuBarShown(),
          click: (item) => void setMenuBar({ shown: item.checked })
        },
        // also here, not only in the popover: Linux trays mostly offer just a menu, and the item may be hidden
        ...(openAtLoginShown() === null
          ? []
          : [{ label: 'Open at Login', type: 'checkbox' as const, checked: openAtLoginShown() === true, click: (item: MenuItem) => void setMenuBar({ openAtLogin: item.checked }) }]),
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        ...(installKind() === 'dev' ? [{ role: 'toggleDevTools' as const }] : []),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

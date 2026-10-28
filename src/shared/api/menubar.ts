/**
 * Menu bar domain contract: the menu bar item (the tray icon on Windows and Linux) and its popover
 * (src/renderer/popover). The popover reads sessions and limits from their own domains and the alert settings from
 * `sessions.alertPrefs()`; this domain is what only the menu bar has.
 */

export interface MenubarState {
  /** The menu bar item is shown. Hidden, closing the window works as it did before the menu bar existed. */
  shown: boolean
  /** Claudock opens at login (menu bar item only, no window). Null: this copy can't, because it runs from a git
   *  clone or from npx's cache folder, which changes between runs. */
  openAtLogin: boolean | null
}

export interface MenubarApi {
  get(): Promise<MenubarState>
  set(patch: { shown?: boolean; openAtLogin?: boolean }): Promise<MenubarState>
  /** Bring Claudock's window forward (opening it if closed); the popover closes. */
  openWindow(): Promise<void>
  /** The same, with the ⌘K palette open. */
  openPalette(): Promise<void>
  /** The popover's content height in CSS pixels, so its window fits it. */
  fit(height: number): Promise<void>
  /** Close the popover (Esc). */
  close(): Promise<void>
  quit(): Promise<void>
}

export interface MenubarEvents {
  'menubar:changed': MenubarState
  /** The popover was opened: it shows its first view again. */
  'menubar:opened': null
}

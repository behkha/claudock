import { Search } from 'lucide-react'
import { formatBytes, tildify } from '@shared/format'
import { Kbd } from '@/components'
import { api, isMac, useApi } from '@/lib/api'
import { useNav } from '@/lib/nav'

export function TitleBar(): JSX.Element {
  const { setPaletteOpen } = useNav()
  const mac = isMac()
  const info = useApi(() => api.system.configInfo(), [])
  const size = useApi(() => api.system.configSize(), [])

  const dir = info.data ? tildify(info.data.configDir, info.data.home) : '~/.claude'
  const sizeText = size.data ? formatBytes(size.data.bytes) : size.error ? 'size unavailable' : 'measuring…'

  return (
    <header className={mac ? 'titlebar titlebar--mac' : 'titlebar'}>
      <span className="titlebar__name">Claudock</span>
      <span className="titlebar__path selectable" title={info.data?.configDir}>
        {dir} · {sizeText}
      </span>
      <button type="button" className="titlebar__search" onClick={() => setPaletteOpen(true)} aria-label="Search (command palette)" aria-keyshortcuts={mac ? 'Meta+K' : 'Control+K'}>
        <Search size={15} strokeWidth={1.8} aria-hidden />
        <span className="titlebar__search-text">Search skills, rules, sessions…</span>
        <Kbd>{mac ? '⌘K' : 'Ctrl K'}</Kbd>
      </button>
    </header>
  )
}

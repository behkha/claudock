import { ErrorBoundary, ToastProvider } from '@/components'
import { NavProvider } from '@/lib/nav'
import { Shell } from '@/shell/Shell'

export default function App(): JSX.Element {
  return (
    <ToastProvider>
      <NavProvider>
        <ErrorBoundary scope="app">
          <Shell />
        </ErrorBoundary>
      </NavProvider>
    </ToastProvider>
  )
}

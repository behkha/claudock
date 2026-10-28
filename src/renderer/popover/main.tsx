import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/tokens.css'
import '../styles/base.css'
import '../styles/components.css'
import './popover.css'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ToastProvider } from '@/components/Toast'
import { Popover } from './Popover'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <ErrorBoundary scope="app">
        <Popover />
      </ErrorBoundary>
    </ToastProvider>
  </StrictMode>
)

import '@fontsource-variable/inter'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'

import { AppProviders } from './app/providers'
import { router } from './app/router'
import { initializeTheme } from './features/theme'
import { installAppErrorReporting, reportAppError } from './shared/api/appErrors'
import './styles.css'
import './shared/ui/nocturne/legacy-bridge.css'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('The application root element is missing.')
}

initializeTheme()
installAppErrorReporting()

// React keeps logging what error boundaries catch; the app error log also keeps it with the component stack.
const reactError = (kind: string) => (error: unknown, info: { componentStack?: string | undefined }) => {
  console.error(error)
  reportAppError(kind, error, `${error instanceof Error ? error.stack ?? '' : ''}\n${info.componentStack ?? ''}`)
}

function bootstrap(element: HTMLElement) {
  createRoot(element, { onCaughtError: reactError('react'), onUncaughtError: reactError('react-uncaught') }).render(
    <StrictMode>
      <AppProviders>
        <RouterProvider router={router} />
      </AppProviders>
    </StrictMode>,
  )
}

bootstrap(rootElement)

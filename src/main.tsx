import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './index.css'
import 'maplibre-gl/dist/maplibre-gl.css'
import './styles/app.css'
import App from './App.tsx'
import { AuthProvider } from './lib/auth'
import { LoginGate } from './components/LoginGate'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <LoginGate>
        <App />
      </LoginGate>
    </AuthProvider>
  </StrictMode>,
)

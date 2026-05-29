import { useState, type ReactNode, type FormEvent } from 'react'
import { useAuth } from '../lib/auth-context'

type Mode = 'signin' | 'signup'

function AuthScreen() {
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setInfo(null)
    setBusy(true)

    if (mode === 'signin') {
      const { error: err } = await signIn(email, password)
      if (err) setError(err.message)
    } else {
      const { error: err, needsConfirmation } = await signUp(email, password)
      if (err) {
        setError(err.message)
      } else if (needsConfirmation) {
        setInfo('Check your email to confirm your account.')
      }
    }

    setBusy(false)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-paper)]">
      <div
        className="w-full max-w-sm rounded-sm border bg-[var(--color-canvas)] px-8 py-10"
        style={{ borderColor: 'var(--color-fog)', borderWidth: 'var(--rule-hair)' }}
      >
        <h1 className="mb-8 text-center font-serif text-2xl leading-none text-[var(--color-ink)]">
          Prospect
        </h1>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="auth-email"
              className="mb-1 block font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-slate)]"
            >
              Email
            </label>
            <input
              id="auth-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-sm border bg-[var(--color-white)] px-3 py-2 font-sans text-sm text-[var(--color-ink)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              style={{ borderColor: 'var(--color-fog)', borderWidth: 'var(--rule-thin)' }}
              autoComplete="email"
            />
          </div>

          <div>
            <label
              htmlFor="auth-password"
              className="mb-1 block font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-slate)]"
            >
              Password
            </label>
            <input
              id="auth-password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-sm border bg-[var(--color-white)] px-3 py-2 font-sans text-sm text-[var(--color-ink)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              style={{ borderColor: 'var(--color-fog)', borderWidth: 'var(--rule-thin)' }}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            />
          </div>

          {error && (
            <p className="font-mono text-xs text-[#8b3a3a]">{error}</p>
          )}

          {info && (
            <p className="font-mono text-xs text-[var(--color-accent)]">{info}</p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-sm bg-[var(--color-accent)] px-4 py-2 font-mono text-xs uppercase tracking-[0.08em] text-white transition-colors hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
          >
            {busy
              ? '…'
              : mode === 'signin'
                ? 'Sign in'
                : 'Create account'}
          </button>
        </form>

        <p className="mt-6 text-center">
          <button
            type="button"
            onClick={() => {
              setMode(mode === 'signin' ? 'signup' : 'signin')
              setError(null)
              setInfo(null)
            }}
            className="font-mono text-[11px] text-[var(--color-slate)] underline-offset-2 hover:text-[var(--color-graphite)] hover:underline"
          >
            {mode === 'signin' ? 'Create account' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  )
}

export function LoginGate({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--color-paper)]">
        <p className="font-serif text-lg text-[var(--color-mist)]">Prospect</p>
      </div>
    )
  }

  if (!session) return <AuthScreen />

  return <>{children}</>
}

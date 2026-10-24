import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { HardDrive } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { GoogleLogo } from '@/components/auth/GoogleLogo'
import { Input } from '@/components/ui/input'
import { apiFetch } from '@/lib/api'
import { setAuthSession, type AuthUser } from '@/lib/auth'
import loginWallpaper from '@/assets/login-wallpaper.jpg'

type AuthResponse = { accessToken: string; refreshToken: string; user: AuthUser }

export function LoginPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)

  async function continueWithGoogle() {
    setGoogleLoading(true)
    setError('')
    try {
      const data = await apiFetch<{ url: string }>('/auth/google/url', { skipAuth: true })
      window.location.href = data.url
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google login failed')
      setGoogleLoading(false)
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      const data = await apiFetch<AuthResponse>('/auth/login', { method: 'POST', skipAuth: true, body: JSON.stringify({ email, password }) })
      setAuthSession(data.accessToken, data.refreshToken, data.user)
      navigate('/all-files')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="auth-crimson relative flex min-h-dvh items-center justify-center overflow-hidden p-5 lg:justify-end lg:px-[8vw]">
      {/* Wallpaper sits on its own layer: global CSS forces <main> backgrounds to transparent. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[#0b0405] bg-cover bg-[position:center_top]" style={{ backgroundImage: `url(${loginWallpaper})` }} />
      {/* Darkens the wallpaper behind the form so text stays readable (WCAG AA contrast). */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,rgba(11,4,5,0.35),rgba(11,4,5,0.8))] lg:bg-[linear-gradient(to_right,rgba(11,4,5,0.1)_30%,rgba(11,4,5,0.85)_75%)]" />
      <Card className="relative w-full max-w-md rounded-2xl border-white/10 bg-[rgba(18,6,8,0.62)] p-6 shadow-[0_24px_80px_rgba(127,29,29,0.45)] backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-red-700 text-white shadow-[0_0_24px_rgba(220,38,38,0.45)]"><HardDrive className="h-6 w-6" /></div>
          <div><h1 className="text-2xl font-extrabold">Login</h1><p className="text-sm text-slate-500">Access your 9Drive gateway.</p></div>
        </div>
        <form onSubmit={submit} className="mt-6 grid min-w-0 gap-4">
          <label className="grid gap-2 text-sm font-semibold">Email<Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="border-white/15 bg-white/5" /></label>
          <label className="grid gap-2 text-sm font-semibold">Password<Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required className="border-white/15 bg-white/5" /></label>
          {error ? <p role="alert" className="rounded-xl border border-red-500/30 bg-red-950/60 p-3 text-sm [overflow-wrap:anywhere]">{error}</p> : null}
          <Button disabled={loading} className="bg-red-700 text-white shadow-[0_8px_24px_rgba(220,38,38,0.35)] hover:bg-red-600 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#120608]">{loading ? 'Logging in...' : 'Login'}</Button>
        </form>
        <div className="mt-4 grid gap-3">
          <div className="flex items-center gap-3 text-xs font-semibold uppercase tracking-wide text-slate-400"><span className="h-px flex-1 bg-white/10" />or<span className="h-px flex-1 bg-white/10" /></div>
          <Button variant="outline" disabled={googleLoading} onClick={continueWithGoogle} className="border-white/15 bg-white/5 text-[#f5e9ea] hover:border-red-500/50 hover:bg-red-950/40 focus-visible:ring-red-400"><GoogleLogo />{googleLoading ? 'Redirecting...' : 'Continue with Google'}</Button>
        </div>
        <p className="mt-5 text-center text-sm text-slate-500">No account? <Link className="rounded font-bold text-red-400 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400" to="/register">Register</Link></p>
      </Card>
    </main>
  )
}

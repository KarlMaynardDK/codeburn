import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { ApiError, getAuthMethods, getMeta, login, logout, setUnauthorizedHandler, type Filters, type Meta } from './lib/api'
import { computeRange, isValidDay, PERIOD_OPTIONS, type PeriodKey } from './lib/period'
import { Button, Loading, selectCls } from './ui'
import { Overview } from './pages/Overview'
import { People, PersonDetail } from './pages/People'
import { Models } from './pages/Models'
import { Projects } from './pages/Projects'
import { Tools } from './pages/Tools'
import { Work } from './pages/Work'
import { Sessions } from './pages/Sessions'
import { Insights } from './pages/Insights'
import { Register } from './Register'

type Page = 'overview' | 'people' | 'models' | 'tools' | 'projects' | 'work' | 'sessions' | 'insights'
const PAGES: Array<{ key: Page; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'people', label: 'People' },
  { key: 'models', label: 'Models & tools' },
  { key: 'tools', label: 'MCP & skills' },
  { key: 'projects', label: 'Projects' },
  { key: 'work', label: 'Repos & PRs' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'insights', label: 'Insights' },
]

/** Hash route: #/page or #/people/<id>. */
function parseHash(): { page: Page; id?: string } {
  const [, p, id] = location.hash.split('/')
  const page = PAGES.find((x) => x.key === p)?.key ?? 'overview'
  return { page, id: id ? decodeURIComponent(id) : undefined }
}

function useRoute() {
  const [route, setRoute] = useState(parseHash)
  useEffect(() => {
    const h = () => setRoute(parseHash())
    window.addEventListener('hashchange', h)
    return () => window.removeEventListener('hashchange', h)
  }, [])
  const go = useCallback((page: Page, id?: string) => {
    location.hash = '#/' + page + (id ? '/' + encodeURIComponent(id) : '')
  }, [])
  return { route, go }
}

const LOGIN_ERRORS: Record<string, string> = {
  denied: "Your GitLab account isn't authorised for this team server.",
  failed: 'GitLab sign-in failed. Try again.',
}

/** Reads ?login_error= once from the GitLab callback redirect and strips it from the address bar. */
function takeLoginError(): string {
  const params = new URLSearchParams(location.search)
  const code = params.get('login_error')
  if (!code) return ''
  params.delete('login_error')
  const rest = params.toString()
  history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash)
  return LOGIN_ERRORS[code] ?? LOGIN_ERRORS.failed!
}

function Login({ onDone, expired }: { onDone: () => void; expired: boolean }) {
  const [key, setKey] = useState('')
  const [err, setErr] = useState(takeLoginError)
  const [busy, setBusy] = useState(false)
  const methods = useQuery({ queryKey: ['auth-methods'], queryFn: getAuthMethods, staleTime: Infinity })
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      await login(key.trim())
      setKey('')
      onDone()
    } catch (x) {
      setErr(x instanceof ApiError && x.status === 401 ? 'Invalid viewer key.' : 'Sign-in failed. Try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-outer-background p-6">
      <Card className="w-full max-w-sm px-6 py-6">
        <h1 className="text-lg font-semibold">CodeBurn Team</h1>
        <p className="mt-1 text-xs text-tertiary-foreground">
          {expired ? 'Your session ended. ' : ''}
          {methods.data?.gitlab ? 'Sign in with GitLab, or enter a viewer key.' : 'Enter your viewer key to continue.'}
        </p>
        {methods.data?.gitlab ? (
          <>
            <a
              href="/auth/gitlab/login"
              className="mt-4 flex justify-center rounded-md border border-border bg-card px-2.5 py-2 text-sm text-foreground hover:bg-interactive-secondary"
            >
              Sign in with GitLab
            </a>
            <div className="mt-4 flex items-center gap-3 text-xs text-tertiary-foreground">
              <div className="h-px flex-1 bg-border" />
              or
              <div className="h-px flex-1 bg-border" />
            </div>
          </>
        ) : null}
        <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
          <input
            type="password"
            autoFocus
            autoComplete="off"
            placeholder="cbv_..."
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="rounded-md border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
          />
          {err ? <div className="text-xs text-red-500">{err}</div> : null}
          <Button type="submit" disabled={busy || !key.trim()} className="justify-center py-2 text-sm">
            {busy ? 'Signing in...' : 'Sign in'}
          </Button>
        </form>
      </Card>
    </div>
  )
}

export function App() {
  const qc = useQueryClient()
  const [authed, setAuthed] = useState<'checking' | 'in' | 'out'>('checking')
  const [expired, setExpired] = useState(false)

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAuthed((a) => {
        if (a === 'in') setExpired(true)
        return 'out'
      })
      qc.clear()
    })
  }, [qc])

  const meta = useQuery({
    queryKey: ['meta'],
    queryFn: getMeta,
    enabled: authed !== 'out',
    retry: false,
  })
  useEffect(() => {
    if (meta.data) setAuthed('in')
  }, [meta.data])

  if (authed === 'out' || (meta.error instanceof ApiError && meta.error.status === 401)) {
    return (
      <Login
        expired={expired}
        onDone={() => {
          setExpired(false)
          setAuthed('checking')
          qc.invalidateQueries()
        }}
      />
    )
  }
  if (meta.error) {
    return <div className="p-10 text-center text-sm text-red-500">Cannot reach the team server ({String((meta.error as Error).message)}).</div>
  }
  if (!meta.data) return <Loading />
  const onLogout = async () => {
    await logout()
    qc.clear()
    setAuthed('out')
    setExpired(false)
  }
  const role = meta.data.viewer?.role ?? 'admin'
  if (role === 'registrant' || (role === 'member' && meta.data.registration && location.pathname === '/register')) {
    return <Register meta={meta.data} onLogout={onLogout} />
  }
  return <Shell meta={meta.data} onLogout={onLogout} />
}

function Shell({ meta, onLogout }: { meta: Meta; onLogout: () => void }) {
  const { route, go } = useRoute()
  const [period, setPeriod] = useState<PeriodKey>('30d')
  const [custom, setCustom] = useState(() => computeRange('30d'))
  const [team, setTeam] = useState('')
  const [person, setPerson] = useState('')
  const [compare, setCompare] = useState(false)

  const range = useMemo(() => computeRange(period, new Date(), custom), [period, custom])
  const filters: Filters = { ...range, team: team || undefined, person: person || undefined }
  const hasSessions = meta.detail_levels?.includes('sessions') ?? false
  const pages = PAGES.filter((p) => (p.key !== 'sessions' && p.key !== 'work') || hasSessions)
  const page = pages.some((p) => p.key === route.page) ? route.page : 'overview'
  const member = meta.viewer?.role === 'member'
  const people = (meta.people ?? []).filter((p) => !team || p.team === team)

  return (
    <div className="min-h-screen bg-outer-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-base font-semibold">CodeBurn Team</h1>
          {meta.org_name ? <span className="text-sm text-tertiary-foreground">{meta.org_name}</span> : null}
        </div>
        <div className="flex items-center gap-3 text-xs text-tertiary-foreground">
          {member && meta.registration ? (
            <a href="/register" className="text-primary hover:underline">
              Set up another machine
            </a>
          ) : null}
          {meta.viewer?.name ? <span>{meta.viewer.name}</span> : null}
          <Button onClick={onLogout}>Log out</Button>
        </div>
      </header>
      <nav className="flex flex-wrap gap-1 border-b border-border px-4 py-2">
        {pages.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => go(p.key)}
            className={cn(
              'rounded-md px-3 py-1.5 text-[13.5px]',
              page === p.key ? 'bg-interactive-secondary font-medium' : 'font-light text-muted-foreground hover:text-foreground',
            )}
          >
            {member && p.key === 'people' ? 'My usage' : p.label}
          </button>
        ))}
      </nav>
      <div className="flex flex-wrap items-center gap-3 px-5 py-3 text-xs">
        <select className={selectCls} value={period} onChange={(e) => setPeriod(e.target.value as PeriodKey)} aria-label="Period">
          {PERIOD_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>{o.label}</option>
          ))}
        </select>
        {period === 'custom' ? (
          <>
            <input type="date" className={selectCls} value={custom.from} onChange={(e) => isValidDay(e.target.value) && setCustom({ ...custom, from: e.target.value })} aria-label="From" />
            <span className="text-tertiary-foreground">to</span>
            <input type="date" className={selectCls} value={custom.to} onChange={(e) => isValidDay(e.target.value) && setCustom({ ...custom, to: e.target.value })} aria-label="To" />
          </>
        ) : (
          <span className="text-tertiary-foreground">{range.from} to {range.to}</span>
        )}
        {!member && (meta.teams?.length ?? 0) > 0 ? (
          <select className={selectCls} value={team} onChange={(e) => { setTeam(e.target.value); setPerson('') }} aria-label="Team">
            <option value="">All teams</option>
            {meta.teams!.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        ) : null}
        {!member && people.length > 0 && page !== 'people' ? (
          <select className={selectCls} value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Person">
            <option value="">Everyone</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        ) : null}
        {page === 'overview' ? (
          <label className="flex items-center gap-1.5 text-muted-foreground">
            <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
            Compare to previous period
          </label>
        ) : null}
      </div>
      <main className="px-5 pb-10">
        {page === 'overview' && <Overview filters={filters} compare={compare} />}
        {page === 'people' &&
          (member && meta.person_id ? (
            <PersonDetail id={meta.person_id} filters={{ ...filters, person: undefined }} />
          ) : route.id ? (
            <PersonDetail id={route.id} filters={{ ...filters, person: undefined }} onBack={() => go('people')} />
          ) : (
            <People filters={{ ...filters, person: undefined }} onOpen={(id) => go('people', id)} />
          ))}
        {page === 'models' && <Models filters={filters} />}
        {page === 'tools' && <Tools filters={filters} />}
        {page === 'projects' && <Projects filters={filters} />}
        {page === 'work' && <Work filters={filters} />}
        {page === 'sessions' && <Sessions filters={filters} />}
        {page === 'insights' && <Insights filters={filters} />}
      </main>
    </div>
  )
}


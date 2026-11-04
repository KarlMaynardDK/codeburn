import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { usd } from '@/lib/utils'
import { ApiError, getProfile, saveProfile, type Profile as ProfileData } from '../lib/api'
import { Button, ErrorNote, Loading, Panel } from '../ui'

const NAME_MAX_LENGTH = 100
const TEAM_MAX_LENGTH = 64

function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'invalid_name') return `Enter a name of 1-${NAME_MAX_LENGTH} characters.`
    if (e.code === 'invalid_team') return `Enter a team name of 1-${TEAM_MAX_LENGTH} characters.`
    if (e.code === 'invalid_projects') return 'One of the project names is not valid.'
  }
  return 'Could not save. Try again.'
}

const inputCls =
  'rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary'

function ProfileForm({ profile }: { profile: ProfileData }) {
  const qc = useQueryClient()
  const [name, setName] = useState(profile.name)
  const [team, setTeam] = useState(profile.team)
  const [hidden, setHidden] = useState(() => new Set(profile.projects.filter((p) => p.hidden).map((p) => p.project)))
  const [saved, setSaved] = useState(false)

  const save = useMutation({
    mutationFn: () => saveProfile({ name, team, hidden_projects: [...hidden] }),
    onSuccess: (fresh) => {
      qc.setQueryData(['profile'], fresh)
      // Names, teams and project labels changed under every other page, and the header shows the name.
      qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'profile' })
      setSaved(true)
    },
  })

  const initialHidden = profile.projects.filter((p) => p.hidden).map((p) => p.project)
  const dirty =
    name !== profile.name ||
    team !== profile.team ||
    hidden.size !== initialHidden.length ||
    initialHidden.some((p) => !hidden.has(p))

  const toggle = (project: string, on: boolean) => {
    setSaved(false)
    setHidden((prev) => {
      const next = new Set(prev)
      if (on) next.add(project)
      else next.delete(project)
      return next
    })
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <Panel title="My details">
        <div className="flex max-w-lg flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-tertiary-foreground">
            Name
            <input
              required
              maxLength={NAME_MAX_LENGTH}
              value={name}
              onChange={(e) => {
                setSaved(false)
                setName(e.target.value)
              }}
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-tertiary-foreground">
            Team
            <input
              required
              list="cb-profile-teams"
              maxLength={TEAM_MAX_LENGTH}
              value={team}
              onChange={(e) => {
                setSaved(false)
                setTeam(e.target.value)
              }}
              className={inputCls}
            />
          </label>
          <datalist id="cb-profile-teams">
            {profile.teams.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <div className="flex flex-col gap-1 text-xs text-tertiary-foreground">
            Email
            <div className="rounded-md border border-border bg-outer-background px-3 py-2 text-sm text-foreground">{profile.email || '-'}</div>
            <span>Your email links this account to your GitLab sign-in, so it can't be changed here.</span>
          </div>
        </div>
      </Panel>

      <Panel title="Hide projects">
        <p className="mb-3 max-w-2xl text-xs text-tertiary-foreground">
          Tick a project to hide it. Its usage still counts in your totals, but it shows as <strong>unknown</strong> to everyone,
          including admins, and its repo and pull requests show as unknown too. Untick it to show the real name again.
          Only you see these names. A project you use for the first time later is hidden as soon as its usage arrives.
        </p>
        {profile.projects.length === 0 ? (
          <div className="py-4 text-sm text-tertiary-foreground">No projects yet. They appear here once your usage has been sent.</div>
        ) : (
          <ul className="flex max-w-2xl flex-col divide-y divide-border rounded-md border border-border">
            {profile.projects.map((p) => (
              <li key={p.project}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-interactive-secondary">
                  <input type="checkbox" checked={hidden.has(p.project)} onChange={(e) => toggle(p.project, e.target.checked)} />
                  <span className="flex-1 break-all">{p.project}</span>
                  <span className="text-xs text-tertiary-foreground">{usd(p.cost)}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending || !dirty || !name.trim() || !team.trim()} className="justify-center px-4 py-2 text-sm">
          {save.isPending ? 'Saving...' : 'Save changes'}
        </Button>
        {saved && !dirty ? <span className="text-xs text-green-600">Saved.</span> : null}
        {save.error ? <span className="text-xs text-red-500">{errorText(save.error)}</span> : null}
      </div>
    </form>
  )
}

/** A member edits their own name, team and hidden projects. */
export function Profile() {
  // Not cached between visits, so the form always starts from what the server has now.
  const q = useQuery({ queryKey: ['profile'], queryFn: getProfile, staleTime: 0, gcTime: 0 })
  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorNote error={q.error} />
  return <ProfileForm profile={q.data!} />
}

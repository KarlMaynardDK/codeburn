import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Check, Copy } from 'lucide-react'

import { Card } from '@/components/ui/card'
import { ApiError, getRegistration, newInstallToken, register, type InstallInfo, type Meta } from './lib/api'
import { noteToParagraphs } from './lib/note'
import { Button, ErrorNote, Loading } from './ui'

const TEAM_MAX_LENGTH = 64

function CopyLine({ label, text }: { label?: string; text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable: the text is still selectable */
    }
  }
  return (
    <div className="flex flex-col gap-1">
      {label ? <div className="text-xs text-tertiary-foreground">{label}</div> : null}
      <div className="flex items-start gap-2">
        <code className="flex-1 select-all break-all rounded-md border border-border bg-outer-background px-3 py-2 font-mono text-xs">{text}</code>
        <Button onClick={copy} title="Copy" aria-label={`Copy ${label ?? text}`}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </Button>
      </div>
    </div>
  )
}

function Note({ note }: { note: string }) {
  const paragraphs = noteToParagraphs(note)
  if (!paragraphs.length) return null
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
      {paragraphs.map((parts, i) => (
        <p key={i} className="whitespace-pre-line">
          {parts.map((part, j) =>
            'href' in part ? (
              <a key={j} href={part.href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                {part.href}
              </a>
            ) : (
              <span key={j}>{part.text}</span>
            ),
          )}
        </p>
      ))}
    </div>
  )
}

export function Instructions({ info }: { info: InstallInfo }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">
        Install token for <strong>{info.person.name}</strong> ({info.person.email}), team <strong>{info.person.team}</strong>.
      </p>
      <CopyLine label="Install token" text={info.token} />
      <p className="text-xs text-tertiary-foreground">
        The token works once, on one machine, until {new Date(info.expires_at).toLocaleString()}. Run one of these commands on the machine you want to connect:
      </p>
      {info.install ? (
        <>
          <CopyLine label="macOS / Linux" text={info.install.unix} />
          <CopyLine label="Windows PowerShell" text={info.install.windows} />
          <CopyLine label="Already have this build installed" text={info.setup} />
        </>
      ) : (
        <CopyLine label="With codeburn installed" text={info.setup} />
      )}
      {info.steps.length ? (
        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <p className="text-sm font-medium">Then, on that machine</p>
          <p className="text-xs text-tertiary-foreground">
            Setting up a machine resets your automatic-sync consent, so these finish the job. Run them in order.
          </p>
          <ol className="flex flex-col gap-4">
            {info.steps.map((s, k) => (
              <li key={s.title} className="flex flex-col gap-1.5">
                <div className="text-sm">
                  <span className="mr-1.5 text-tertiary-foreground">{k + 1}.</span>
                  <strong>{s.title}</strong>
                </div>
                {s.note ? <div className="text-xs text-tertiary-foreground">{s.note}</div> : null}
                {s.commands.map((c) => (
                  <CopyLine key={c} text={c} />
                ))}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      <a href="/help" target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline">
        Full help: what is sent, upgrading, logging out and uninstalling
      </a>
    </div>
  )
}

function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'invalid_team') return `Enter a team name of 1-${TEAM_MAX_LENGTH} characters.`
    if (e.code === 'email_taken') return 'Someone is already registered with your email. Ask your admin for help.'
    if (e.code === 'too_many_attempts') return 'Too many install tokens requested. Try again later.'
    if (e.code === 'not_registrant' || e.code === 'already_registered') return 'You are already registered. Reload the page.'
  }
  return 'Something went wrong. Try again.'
}

/** Self-registration for a GitLab user who is not yet a person, and "set up another machine" for members. */
export function Register({ meta, onLogout }: { meta: Meta; onLogout: () => void }) {
  const q = useQuery({ queryKey: ['registration'], queryFn: getRegistration, retry: false })
  const [team, setTeam] = useState('')
  const signUp = useMutation({ mutationFn: register })
  const rotate = useMutation({ mutationFn: newInstallToken })
  const info = signUp.data ?? rotate.data

  let body
  if (q.isLoading) body = <Loading />
  else if (q.error) body = <ErrorNote error={q.error} />
  else if (info) body = <Instructions info={info} />
  else if (q.data!.state === 'new') {
    const r = q.data!
    body = (
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          signUp.mutate(team)
        }}
      >
        <p className="text-sm">
          Hi <strong>{r.name}</strong>. You're not set up on this team server yet. Tell us your team and we'll create your install token.
        </p>
        <div className="text-xs text-tertiary-foreground">Signed in with GitLab as {r.email}</div>
        <label className="flex flex-col gap-1 text-xs text-tertiary-foreground">
          Team
          <input
            autoFocus
            required
            list="cb-teams"
            maxLength={TEAM_MAX_LENGTH}
            placeholder={r.teams[0] ?? 'Your team'}
            value={team}
            onChange={(e) => setTeam(e.target.value)}
            className="rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
          />
        </label>
        <datalist id="cb-teams">
          {r.teams.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <p className="text-xs text-tertiary-foreground">Pick your team from the list, or type a new name if you're the first from your team.</p>
        {signUp.error ? <div className="text-xs text-red-500">{errorText(signUp.error)}</div> : null}
        <Button type="submit" disabled={signUp.isPending || !team.trim()} className="justify-center py-2 text-sm">
          {signUp.isPending ? 'Creating...' : 'Create my install token'}
        </Button>
      </form>
    )
  } else {
    const r = q.data!
    body = (
      <div className="flex flex-col gap-3">
        <p className="text-sm">
          You're registered as <strong>{r.name}</strong> ({r.email}) in team <strong>{r.team}</strong>. To connect another machine, create a new install token.
          Any unused token you had stops working.
        </p>
        {rotate.error ? <div className="text-xs text-red-500">{errorText(rotate.error)}</div> : null}
        <Button onClick={() => rotate.mutate()} disabled={rotate.isPending} className="justify-center py-2 text-sm">
          {rotate.isPending ? 'Creating...' : 'Create a new install token'}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-outer-background p-6 text-foreground">
      <Card className="flex w-full max-w-2xl flex-col gap-4 px-6 py-6">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-lg font-semibold">
            CodeBurn Team{meta.org_name ? <span className="ml-2 text-sm font-normal text-tertiary-foreground">{meta.org_name}</span> : null}
          </h1>
          <Button onClick={onLogout}>Log out</Button>
        </div>
        {body}
        {info || q.data?.state === 'member' ? (
          <a href="/" className="text-sm text-primary hover:underline">
            Go to my dashboard
          </a>
        ) : null}
        {q.data?.note ? <Note note={q.data.note} /> : null}
      </Card>
    </div>
  )
}

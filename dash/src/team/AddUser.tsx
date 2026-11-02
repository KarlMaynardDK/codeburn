import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'

import { Card } from '@/components/ui/card'
import { ApiError, addPerson, type Meta } from './lib/api'
import { Instructions } from './Register'
import { Button } from './ui'

const inputCls = 'rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary'

function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'invalid_name') return 'Enter a name (up to 100 characters).'
    if (e.code === 'invalid_email') return 'Enter a valid email address.'
    if (e.code === 'invalid_team') return 'Enter a team name of 1-64 characters.'
    if (e.code === 'email_taken') return 'Someone with that email already exists.'
    if (e.code === 'too_many_attempts') return 'Too many requests. Try again later.'
  }
  return 'Something went wrong. Try again.'
}

/** Admin: add a person who cannot sign in with GitLab and show their install token and setup instructions. */
export function AddUser({ meta }: { meta: Meta }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [team, setTeam] = useState('')
  const add = useMutation({
    mutationFn: addPerson,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['people'] })
      void qc.invalidateQueries({ queryKey: ['meta'] })
    },
  })

  const close = () => {
    setOpen(false)
    setName('')
    setEmail('')
    setTeam('')
    add.reset()
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>Add user</Button>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-6"
          role="dialog"
          aria-modal="true"
          aria-label="Add user"
          onKeyDown={(e) => e.key === 'Escape' && close()}
        >
          <Card className="my-6 flex w-full max-w-2xl flex-col gap-4 px-6 py-6">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">{add.data ? 'User added' : 'Add user'}</h2>
              <Button onClick={close} aria-label="Close">
                <X size={12} />
              </Button>
            </div>
            {add.data ? (
              <>
                <Instructions info={add.data} />
                <Button onClick={close} className="justify-center py-2 text-sm">
                  Done
                </Button>
              </>
            ) : (
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  add.mutate({ name, email, team })
                }}
              >
                <p className="text-xs text-tertiary-foreground">
                  Creates the person and an install token for their machine. Use this for people who cannot sign in with GitLab.
                </p>
                <label className="flex flex-col gap-1 text-xs text-tertiary-foreground">
                  Name
                  <input autoFocus required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
                </label>
                <label className="flex flex-col gap-1 text-xs text-tertiary-foreground">
                  Email
                  <input required type="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} />
                </label>
                <label className="flex flex-col gap-1 text-xs text-tertiary-foreground">
                  Team
                  <input required list="cb-add-teams" maxLength={64} value={team} onChange={(e) => setTeam(e.target.value)} className={inputCls} />
                </label>
                <datalist id="cb-add-teams">
                  {(meta.teams ?? []).map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
                {add.error ? <div className="text-xs text-red-500">{errorText(add.error)}</div> : null}
                <Button type="submit" disabled={add.isPending || !name.trim() || !email.trim() || !team.trim()} className="justify-center py-2 text-sm">
                  {add.isPending ? 'Creating...' : 'Add user and create install token'}
                </Button>
              </form>
            )}
          </Card>
        </div>
      ) : null}
    </>
  )
}

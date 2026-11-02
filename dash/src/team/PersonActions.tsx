import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { ApiError, newTokenFor, setTeamAdmin, type Meta } from './lib/api'
import { Modal } from './AddUser'
import { Instructions } from './Register'
import { Button } from './ui'

function TeamAdminDialog({ meta, personId, name, onClose }: { meta: Meta; personId: string; name: string; onClose: () => void }) {
  const qc = useQueryClient()
  const current = meta.people?.find((p) => p.id === personId)?.team_admin_of ?? []
  const [picked, setPicked] = useState<string[]>(current)
  const save = useMutation({
    mutationFn: () => setTeamAdmin(personId, picked),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['meta'] })
      onClose()
    },
  })
  const teams = [...new Set([...(meta.teams ?? []), ...current])].sort()
  return (
    <Modal title={`Team admin: ${name}`} onClose={onClose}>
      <p className="text-xs text-tertiary-foreground">
        A team admin sees every member of the teams ticked here, and can add people to them and issue install tokens. They sign in with GitLab as a
        member, so they need an active person on this server. Untick everything to remove the role.
      </p>
      <div className="flex flex-col gap-1.5">
        {teams.length === 0 ? <div className="text-xs text-tertiary-foreground">No teams yet.</div> : null}
        {teams.map((t) => (
          <label key={t} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={picked.includes(t)}
              onChange={(e) => setPicked(e.target.checked ? [...picked, t] : picked.filter((x) => x !== t))}
            />
            {t}
          </label>
        ))}
      </div>
      {save.error ? <div className="text-xs text-red-500">{save.error instanceof ApiError ? save.error.code : 'Something went wrong. Try again.'}</div> : null}
      <Button onClick={() => save.mutate()} disabled={save.isPending} className="justify-center py-2 text-sm">
        {save.isPending ? 'Saving...' : 'Save'}
      </Button>
    </Modal>
  )
}

/** Row actions on the People page: a new install token (admins and team admins) and team-admin rights (admins). */
export function PersonActions({ meta, personId, name }: { meta: Meta; personId: string; name: string }) {
  const [dialog, setDialog] = useState<'token' | 'admin' | null>(null)
  const token = useMutation({ mutationFn: () => newTokenFor(personId) })
  const isAdmin = meta.viewer?.role === 'admin'
  const grants = meta.people?.find((p) => p.id === personId)?.team_admin_of ?? []
  const close = () => {
    setDialog(null)
    token.reset()
  }
  return (
    <div className="flex items-center gap-1.5">
      <Button
        onClick={() => {
          setDialog('token')
          token.mutate()
        }}
      >
        New token
      </Button>
      {isAdmin ? <Button onClick={() => setDialog('admin')}>{grants.length ? `Team admin (${grants.length})` : 'Team admin'}</Button> : null}
      {dialog === 'token' ? (
        <Modal title={`Install token: ${name}`} onClose={close}>
          {token.isPending ? <div className="text-sm text-tertiary-foreground">Creating...</div> : null}
          {token.error ? <div className="text-xs text-red-500">Could not create a token. Try again.</div> : null}
          {token.data ? (
            <>
              <p className="text-xs text-tertiary-foreground">Any unused token {name} had no longer works.</p>
              <Instructions info={token.data} />
              <Button onClick={close} className="justify-center py-2 text-sm">
                Done
              </Button>
            </>
          ) : null}
        </Modal>
      ) : null}
      {dialog === 'admin' ? <TeamAdminDialog meta={meta} personId={personId} name={name} onClose={close} /> : null}
    </div>
  )
}

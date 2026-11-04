import { describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import {
  buildSchtasksCreateArgs,
  buildSystemdService,
  buildSystemdTimer,
  getScheduleStatus,
  installSchedule,
  removeSchedule,
  type ScheduleDeps,
} from '../src/sync/schedule-installer.js'

function makeDeps(platform: NodeJS.Platform, runImpl?: (c: string, a: string[]) => Promise<string>) {
  const calls: Array<[string, string[]]> = []
  const writes: Record<string, string> = {}
  const warnings: string[] = []
  const deps: Partial<ScheduleDeps> = {
    platform,
    home: '/home/u',
    run: async (c, a) => {
      calls.push([c, a])
      return runImpl ? runImpl(c, a) : ''
    },
    fs: {
      mkdirSync: vi.fn(),
      writeFileSync: (p: string, data: string) => { writes[p] = data },
      unlinkSync: vi.fn(),
      existsSync: () => true,
    },
    warn: (m) => { warnings.push(m) },
  }
  return { deps, calls, writes, warnings }
}

const NODE_WIN = 'C:\\Program Files\\nodejs\\node.exe'
const CLI_WIN = 'C:\\Users\\a b\\cli.js'

describe('windows schedule', () => {
  it('creates a task with quoted paths via argv array', async () => {
    const { deps, calls } = makeDeps('win32')
    await installSchedule('hourly', NODE_WIN, CLI_WIN, deps)
    expect(calls).toEqual([['schtasks', [
      '/Create', '/TN', 'codeburn-sync', '/SC', 'HOURLY',
      '/TR', `"${NODE_WIN}" "${CLI_WIN}" sync auto run`, '/F',
    ]]])
  })

  it('uses DAILY for daily cadence and honours task name override', () => {
    const args = buildSchtasksCreateArgs('daily', 'node', 'cli.js', 'x')
    expect(args.slice(0, 5)).toEqual(['/Create', '/TN', 'x', '/SC', 'DAILY'])
  })

  it('deletes and queries', async () => {
    const a = makeDeps('win32')
    await removeSchedule(a.deps)
    expect(a.calls).toEqual([['schtasks', ['/Delete', '/TN', 'codeburn-sync', '/F']]])
    const b = makeDeps('win32')
    expect((await getScheduleStatus(b.deps)).installed).toBe(true)
    expect(b.calls).toEqual([['schtasks', ['/Query', '/TN', 'codeburn-sync']]])
    const c = makeDeps('win32', async () => { throw new Error('nope') })
    expect((await getScheduleStatus(c.deps)).installed).toBe(false)
  })

  it('wraps create failures and tolerates delete failures', async () => {
    const { deps } = makeDeps('win32', async () => { throw new Error('denied') })
    await expect(installSchedule('daily', 'n', 's', deps)).rejects.toThrow(/Failed to install schedule: denied/)
    await expect(removeSchedule(deps)).resolves.toBeUndefined()
  })
})

describe('linux schedule', () => {
  it('writes unit files and enables the timer', async () => {
    const { deps, calls, writes } = makeDeps('linux')
    await installSchedule('daily', '/usr/bin/node', '/opt/my dir/cli.js', deps)
    const dir = join('/home/u', '.config', 'systemd', 'user')
    const service = writes[join(dir, 'codeburn-sync.service')]
    const timer = writes[join(dir, 'codeburn-sync.timer')]
    expect(service).toContain('ExecStart="/usr/bin/node" "/opt/my dir/cli.js" sync auto run')
    expect(timer).toContain('OnCalendar=daily')
    expect(timer).toContain('Persistent=true')
    expect(calls.map(c => c[1].join(' '))).toEqual([
      '--user show-environment',
      '--user daemon-reload',
      '--user enable --now codeburn-sync.timer',
    ])
  })

  it('uses hourly calendar and escapes percent signs', () => {
    expect(buildSystemdTimer('hourly')).toContain('OnCalendar=hourly')
    expect(buildSystemdService('/n', '/a%b')).toContain('"/a%%b"')
  })

  it('falls back to crontab hint when systemctl --user is unavailable', async () => {
    const { deps, calls, writes, warnings } = makeDeps('linux', async () => { throw new Error('no bus') })
    await installSchedule('hourly', '/usr/bin/node', '/cli.js', deps)
    expect(calls).toHaveLength(1)
    expect(Object.keys(writes)).toHaveLength(0)
    expect(warnings.join('')).toContain('0 * * * * /usr/bin/node /cli.js sync auto run')
  })

  it('removes units', async () => {
    const { deps, calls } = makeDeps('linux')
    await removeSchedule(deps)
    expect(calls[0][1]).toEqual(['--user', 'disable', '--now', 'codeburn-sync.timer'])
    expect(deps.fs!.unlinkSync).toHaveBeenCalledTimes(2)
  })
})

describe('macOS schedule unchanged', () => {
  it('writes the plist and loads via launchctl', async () => {
    const { deps, calls, writes } = makeDeps('darwin')
    await installSchedule('daily', '/usr/bin/node', '/cli.js', deps)
    const plist = join('/home/u', 'Library', 'LaunchAgents', 'com.codeburn.sync-auto.plist')
    expect(writes[plist]).toContain('<integer>86400</integer>')
    expect(calls).toEqual([
      ['/bin/launchctl', ['unload', plist]],
      ['/bin/launchctl', ['load', plist]],
    ])
  })

  it('unloads and deletes on remove', async () => {
    const { deps, calls } = makeDeps('darwin')
    await removeSchedule(deps)
    expect(calls[0][0]).toBe('/bin/launchctl')
    expect(deps.fs!.unlinkSync).toHaveBeenCalledTimes(1)
  })
})

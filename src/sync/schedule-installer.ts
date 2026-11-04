/**
 * codeburn sync - schedule installer for automatic pushes.
 *
 * macOS: LaunchAgent plist. Windows: Task Scheduler (schtasks).
 * Linux: systemd user timer, falling back to a crontab hint.
 */

import { platform, homedir } from 'os'
import { join } from 'path'
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import { execFile } from 'child_process'

const SCHEDULE_AGENT_NAME = 'com.codeburn.sync-auto'
const SCHEDULE_INTERVAL_DAILY = 86400
const SCHEDULE_INTERVAL_HOURLY = 3600
export const WINDOWS_TASK_NAME = 'codeburn-sync'
export const SYSTEMD_UNIT_NAME = 'codeburn-sync'

export type ScheduleDeps = {
  platform: NodeJS.Platform
  home: string
  run: (command: string, args: string[]) => Promise<string>
  fs: {
    mkdirSync: (path: string, opts: { recursive: boolean }) => unknown
    writeFileSync: (path: string, data: string, opts?: { mode: number }) => void
    unlinkSync: (path: string) => void
    existsSync: (path: string) => boolean
  }
  warn: (message: string) => void
  /** Windows task name override (tests / manual verification). */
  taskName?: string
}

export type ScheduleStatus = {
  installed: boolean
  mechanism: 'launchd' | 'schtasks' | 'systemd' | 'none'
  detail?: string
}

function defaultRun(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || '').trim()
        reject(new Error(`${command} failed: ${detail || err.message}`))
      } else {
        resolve(String(stdout))
      }
    })
  })
}

function resolveDeps(overrides?: Partial<ScheduleDeps>): ScheduleDeps {
  return {
    platform: platform(),
    home: homedir(),
    run: defaultRun,
    fs: { mkdirSync, writeFileSync, unlinkSync, existsSync },
    warn: (m) => { process.stderr.write(m) },
    ...overrides,
  }
}

function launchAgentDir(home: string): string {
  return join(home, 'Library', 'LaunchAgents')
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function buildLaunchAgentPlist(
  cadence: 'daily' | 'hourly',
  runtimePath: string,
  scriptPath: string,
): string {
  const interval = cadence === 'daily' ? SCHEDULE_INTERVAL_DAILY : SCHEDULE_INTERVAL_HOURLY
  const safeRuntime = xmlEscape(runtimePath)
  const safeScript = xmlEscape(scriptPath)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SCHEDULE_AGENT_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${safeRuntime}</string>
    <string>${safeScript}</string>
    <string>sync</string>
    <string>auto</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key>
    <string>1</string>
  </dict>
  <key>StartInterval</key>
  <integer>${interval}</integer>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`
}

function winQuote(value: string): string {
  return `"${value.replace(/"/g, '')}"`
}

/** Value for schtasks /TR: quoted runtime and script paths plus the subcommand. */
export function buildWindowsTaskCommand(runtimePath: string, scriptPath: string): string {
  return `${winQuote(runtimePath)} ${winQuote(scriptPath)} sync auto run`
}

export function buildSchtasksCreateArgs(
  cadence: 'daily' | 'hourly',
  runtimePath: string,
  scriptPath: string,
  taskName: string = WINDOWS_TASK_NAME,
): string[] {
  return [
    '/Create', '/TN', taskName,
    '/SC', cadence === 'daily' ? 'DAILY' : 'HOURLY',
    '/TR', buildWindowsTaskCommand(runtimePath, scriptPath),
    '/F',
  ]
}

function systemdQuote(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')
  return `"${escaped}"`
}

export function buildSystemdService(runtimePath: string, scriptPath: string): string {
  return `[Unit]
Description=CodeBurn automatic sync push

[Service]
Type=oneshot
ExecStart=${systemdQuote(runtimePath)} ${systemdQuote(scriptPath)} sync auto run
`
}

export function buildSystemdTimer(cadence: 'daily' | 'hourly'): string {
  return `[Unit]
Description=CodeBurn automatic sync schedule (${cadence})

[Timer]
OnCalendar=${cadence}
Persistent=true
Unit=${SYSTEMD_UNIT_NAME}.service

[Install]
WantedBy=timers.target
`
}

function systemdDir(home: string): string {
  return join(home, '.config', 'systemd', 'user')
}

function crontabHint(cadence: 'daily' | 'hourly', runtimePath: string, scriptPath: string): string {
  const expr = cadence === 'daily' ? '0 0 * * *' : '0 * * * *'
  return `To schedule automatic syncs, add to crontab:\n  ${expr} ${runtimePath} ${scriptPath} sync auto run\n`
}

export async function installSchedule(
  cadence: 'daily' | 'hourly',
  runtimePath: string,
  scriptPath: string,
  overrides?: Partial<ScheduleDeps>,
): Promise<void> {
  const d = resolveDeps(overrides)

  if (d.platform === 'win32') {
    try {
      await d.run('schtasks', buildSchtasksCreateArgs(cadence, runtimePath, scriptPath, d.taskName))
    } catch (err) {
      throw new Error(`Failed to install schedule: ${err instanceof Error ? err.message : String(err)}`)
    }
    return
  }

  if (d.platform === 'linux') {
    let systemdOk = true
    try {
      await d.run('systemctl', ['--user', 'show-environment'])
    } catch {
      systemdOk = false
    }
    if (!systemdOk) {
      d.warn(`systemd user session not available.\n${crontabHint(cadence, runtimePath, scriptPath)}`)
      return
    }
    const dir = systemdDir(d.home)
    try {
      d.fs.mkdirSync(dir, { recursive: true })
      d.fs.writeFileSync(join(dir, `${SYSTEMD_UNIT_NAME}.service`), buildSystemdService(runtimePath, scriptPath), { mode: 0o644 })
      d.fs.writeFileSync(join(dir, `${SYSTEMD_UNIT_NAME}.timer`), buildSystemdTimer(cadence), { mode: 0o644 })
      await d.run('systemctl', ['--user', 'daemon-reload'])
      await d.run('systemctl', ['--user', 'enable', '--now', `${SYSTEMD_UNIT_NAME}.timer`])
    } catch (err) {
      throw new Error(`Failed to install schedule: ${err instanceof Error ? err.message : String(err)}`)
    }
    return
  }

  if (d.platform !== 'darwin') {
    d.warn(`Automatic scheduling is not supported on this platform.\n${crontabHint(cadence, runtimePath, scriptPath)}`)
    return
  }

  const plistContent = buildLaunchAgentPlist(cadence, runtimePath, scriptPath)
  const agentDir = launchAgentDir(d.home)
  const plistPath = join(agentDir, `${SCHEDULE_AGENT_NAME}.plist`)

  try {
    d.fs.mkdirSync(agentDir, { recursive: true })
    d.fs.writeFileSync(plistPath, plistContent, { mode: 0o644 })
    try {
      await d.run('/bin/launchctl', ['unload', plistPath])
    } catch {
      // May not be loaded yet
    }
    await d.run('/bin/launchctl', ['load', plistPath])
  } catch (err) {
    throw new Error(`Failed to install schedule: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function removeSchedule(overrides?: Partial<ScheduleDeps>): Promise<void> {
  const d = resolveDeps(overrides)

  if (d.platform === 'win32') {
    try {
      await d.run('schtasks', ['/Delete', '/TN', d.taskName ?? WINDOWS_TASK_NAME, '/F'])
    } catch {
      // May not exist
    }
    return
  }

  if (d.platform === 'linux') {
    const dir = systemdDir(d.home)
    try {
      await d.run('systemctl', ['--user', 'disable', '--now', `${SYSTEMD_UNIT_NAME}.timer`])
    } catch {
      // Not installed or systemd unavailable
    }
    for (const ext of ['timer', 'service']) {
      try {
        d.fs.unlinkSync(join(dir, `${SYSTEMD_UNIT_NAME}.${ext}`))
      } catch {
        // May not exist
      }
    }
    try {
      await d.run('systemctl', ['--user', 'daemon-reload'])
    } catch {
      // ignore
    }
    return
  }

  if (d.platform !== 'darwin') return

  const plistPath = join(launchAgentDir(d.home), `${SCHEDULE_AGENT_NAME}.plist`)
  try {
    await d.run('/bin/launchctl', ['unload', plistPath])
  } catch {
    // May not be loaded
  }
  try {
    d.fs.unlinkSync(plistPath)
  } catch {
    // May not exist
  }
}

export async function getScheduleStatus(overrides?: Partial<ScheduleDeps>): Promise<ScheduleStatus> {
  const d = resolveDeps(overrides)

  if (d.platform === 'win32') {
    try {
      const out = await d.run('schtasks', ['/Query', '/TN', d.taskName ?? WINDOWS_TASK_NAME])
      return { installed: true, mechanism: 'schtasks', detail: out.trim() }
    } catch {
      return { installed: false, mechanism: 'schtasks' }
    }
  }

  if (d.platform === 'linux') {
    try {
      const out = await d.run('systemctl', ['--user', 'is-enabled', `${SYSTEMD_UNIT_NAME}.timer`])
      return { installed: true, mechanism: 'systemd', detail: out.trim() }
    } catch {
      return { installed: false, mechanism: 'systemd' }
    }
  }

  if (d.platform === 'darwin') {
    const plistPath = join(launchAgentDir(d.home), `${SCHEDULE_AGENT_NAME}.plist`)
    return { installed: d.fs.existsSync(plistPath), mechanism: 'launchd', detail: plistPath }
  }

  return { installed: false, mechanism: 'none' }
}

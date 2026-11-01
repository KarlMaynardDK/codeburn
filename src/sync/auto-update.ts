/**
 * Installs the team server's CLI build before a scheduled push.
 *
 * `sync auto run` calls this once discovery is fresh. When the server advertises a build that differs from the
 * installed one (any difference, like `codeburn update`), it runs `codeburn update --cli` in a child process, so
 * the install uses the same verified download path as the manual command. The caller then restarts itself on the
 * new files, because this process still holds the old code.
 */

import { spawn } from 'node:child_process'

import type { SyncConfig } from './config.js'

export interface CliRunResult { code: number | null; stdout: string; stderr: string }

export type AutoUpdateOutcome =
  | { action: 'none' }
  | { action: 'updated'; from: string; to: string }
  | { action: 'failed'; from: string; to: string; reason: string }

export function autoUpdateWanted(
  config: Pick<SyncConfig, 'authMode' | 'autoUpdate' | 'clientPackage'>,
  installed: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (config.authMode !== 'enrollment' || config.autoUpdate === false) return null
  if (env['CODEBURN_NO_AUTO_UPDATE']) return null
  const target = config.clientPackage?.version
  return target && target !== installed ? target : null
}

/** Last `message` of a `codeburn update --json` step event, or the last line of stderr. */
function failureReason(run: CliRunResult): string {
  let message = ''
  for (const line of run.stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as { type?: string; state?: string; message?: string }
      if (event.type === 'step' && event.state === 'error' && event.message) message = event.message
    } catch { /* not JSON */ }
  }
  return (message || run.stderr.trim().split(/\r?\n/).pop() || `update exited with code ${run.code}`).slice(0, 300)
}

export async function autoUpdateBeforeSync(
  config: Pick<SyncConfig, 'authMode' | 'autoUpdate' | 'clientPackage'>,
  installed: string,
  runCli: (args: string[]) => Promise<CliRunResult>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AutoUpdateOutcome> {
  const target = autoUpdateWanted(config, installed, env)
  if (!target) return { action: 'none' }
  let run: CliRunResult
  try {
    run = await runCli(['update', '--cli', '--json'])
  } catch (err) {
    return { action: 'failed', from: installed, to: target, reason: (err as Error).message }
  }
  if (run.code !== 0) return { action: 'failed', from: installed, to: target, reason: failureReason(run) }
  // `update --cli` also exits 0 when it skipped (managed install, nothing to do); only an install counts.
  const installedNow = run.stdout.split(/\r?\n/).some(line => {
    try {
      const event = JSON.parse(line) as { type?: string; state?: string; component?: string }
      return event.type === 'step' && event.component === 'cli' && event.state === 'done'
    } catch { return false }
  })
  return installedNow
    ? { action: 'updated', from: installed, to: target }
    : { action: 'failed', from: installed, to: target, reason: 'the CLI was not replaced (managed install?); run `codeburn update`' }
}

/** Runs this same CLI entry in a fresh node process. */
export function runSelf(args: string[], options: { inherit?: boolean; timeoutMs?: number } = {}): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const entry = process.argv[1]
    if (!entry) return reject(new Error('cannot locate the codeburn entry point'))
    const child = spawn(process.execPath, [entry, ...args], {
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', d => { stdout += d })
    child.stderr?.on('data', d => { stderr += d })
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 15 * 60_000)
    child.on('error', err => { clearTimeout(timer); reject(err) })
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

import type { TeamServerConfig } from './config.js'
import { installerLines, REFRESH_COMMANDS, setupCommand, teamLabel } from './client-package.js'

/** One step of the "after it is installed" checklist shown on the install-token page, the help page and `team admin`. */
export interface SetupStep {
  title: string
  note?: string
  commands: string[]
}

type Accepts = Pick<TeamServerConfig, 'accept_session_detail' | 'accept_findings' | 'accept_coaching' | 'org_name'> & { install_mode?: TeamServerConfig['install_mode'] }

/**
 * What to run after `codeburn sync setup`. Setup writes a fresh config, which drops the automatic-sync acceptance, so
 * the person chooses what to send, accepts again, checks the result and pushes their history. Only the options this
 * server accepts are offered.
 */
export function postSetupSteps(config: Accepts): SetupStep[] {
  const steps: SetupStep[] = []
  if (config.accept_session_detail || config.accept_findings || config.accept_coaching) {
    steps.push({
      title: 'Choose what to send',
      note: config.install_mode === 'all'
        ? 'The installer already does this, and the next two steps, for you. Run them only if you set up by hand. It turns on everything this server accepts; see "What is sent" on the help page, where each item can also be set on its own.'
        : 'Until you run this only daily usage totals are sent. It turns on everything this server accepts; see "What is sent" on the help page, where each item can also be set on its own.',
      commands: ['codeburn sync config all on'],
    })
  }
  steps.push(
    {
      title: 'Turn automatic sync on',
      note: 'Setting up a machine, and any change to what is sent, resets your consent, so accept it again here. Run the command without --accept first if you want to read the disclosure.',
      commands: ['codeburn sync auto enable --accept'],
    },
    {
      title: 'Check it',
      note: `It should show: Auth: enrollment (team server${config.org_name ? `: ${config.org_name}` : ''}).`,
      commands: ['codeburn sync status'],
    },
    {
      title: 'Push your history',
      note: 'Sends up to six months of past usage. After this the scheduled sync keeps it up to date.',
      commands: ['codeburn sync push --since all'],
    },
  )
  return steps
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const code = (lines: string | string[]) => `<pre>${esc(Array.isArray(lines) ? lines.join('\n') : lines)}</pre>`

const STYLE = `
:root { --bg:#fafaf9; --fg:#1c1917; --muted:#57534e; --line:#e7e5e4; --code:#f5f5f4; --link:#c2410c }
@media (prefers-color-scheme: dark) { :root { --bg:#1c1917; --fg:#f5f5f4; --muted:#a8a29e; --line:#44403c; --code:#292524; --link:#fb923c } }
* { box-sizing: border-box }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif }
main { max-width:48rem; margin:0 auto; padding:1.5rem 1rem 4rem }
h1 { font-size:1.4rem; margin:.2rem 0 .3rem } h2 { font-size:1.1rem; margin:2.2rem 0 .5rem; padding-top:.8rem; border-top:1px solid var(--line) }
p, li { margin:.4rem 0 } .muted { color:var(--muted); font-size:.9rem }
a { color:var(--link) } nav ul { columns:2; padding-left:1.1rem } nav li { margin:.15rem 0 }
pre { background:var(--code); border:1px solid var(--line); border-radius:6px; padding:.6rem .8rem; overflow-x:auto; margin:.5rem 0; font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace }
code { background:var(--code); border-radius:4px; padding:.05rem .3rem; font:.9em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace }
table { border-collapse:collapse; width:100%; margin:.5rem 0 } th, td { text-align:left; vertical-align:top; border-bottom:1px solid var(--line); padding:.4rem .5rem .4rem 0 }
ol.steps > li { margin:.9rem 0 } @media (max-width:560px) { nav ul { columns:1 } }
`

/** How a person gets an install token: themselves after signing in with GitLab, or from an admin. */
function tokenIntro(origin: string, opts: { registration: boolean; signIn?: boolean }): string {
  const expiry = '<p class="muted">A token works once, on one machine, and expires after 7 days.</p>'
  if (opts.registration) {
    return `<p><strong>You can create your own install token.</strong> No need to ask an admin:</p>
<ol>
<li>Open <a href="/">${esc(origin)}/</a> and sign in with GitLab.</li>
<li>First time: choose your team and click <em>Create my install token</em>. Already registered: click <em>Set up another machine</em> in the dashboard header.</li>
<li>Copy the install command it shows and run it on the machine you want to connect. The page also lists what to run afterwards.</li>
</ol>${expiry}`
  }
  return `<p>You need an install token from your admin.${opts.signIn ? ' Signing in with GitLab at <a href="/">' + esc(origin) + '/</a> gives you the dashboard, but this server does not create tokens for you.' : ''}</p>${expiry}`
}

/**
 * The public help page: install, finish setup, what is sent, upgrade, log out and uninstall. `origin` must already be
 * validated (scheme://safe-host[:port]), exactly as for the installer scripts; everything is escaped regardless.
 */
export function helpPage(origin: string, config: TeamServerConfig, opts: { installers: boolean; registration: boolean; signIn?: boolean }): string {
  const org = config.org_name ? ` for ${config.org_name}` : ''
  const steps = postSetupSteps(config)
  const stepList = `<ol class="steps">${steps.map(s => `<li><strong>${esc(s.title)}</strong>${s.note ? `<div class="muted">${esc(s.note)}</div>` : ''}${code(s.commands)}</li>`).join('')}</ol>`
  const lines = installerLines(origin, '<token>')

  const sent: string[] = [
    '<li><strong>Usage totals (always).</strong> Per day: tokens, cost, request counts, model, provider, project folder name, task type, and the names of MCP tools, skills and subagents used. No session grouping and times are rounded to the hour.</li>',
  ]
  if (config.accept_session_detail) sent.push('<li><strong>Session detail</strong> (<code>codeburn sync config detail sessions</code>). Adds session ids, session lengths, call counts, tools and exact timestamps.</li>')
  if (config.accept_findings) sent.push('<li><strong>Optimize findings</strong> (<code>codeburn sync config findings on</code>). A daily snapshot of what <code>codeburn optimize</code> found: finding id, title, severity, trend and estimated savings. Never file paths, file names, commands or explanations.</li>')
  if (config.accept_coaching) sent.push('<li><strong>Coaching stats</strong> (<code>codeburn sync config coaching on</code>). A daily snapshot of counts only: how many prompts you typed, how many times you corrected the assistant, how many sessions edited files, the median time to the first edit, and how many files were reworked across sessions. Never prompt text, file names or paths. Your team uses these to see where training would help.</li>')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CodeBurn Team help</title><style>${STYLE}</style></head>
<body><main>
<h1>CodeBurn Team${esc(org)}</h1>
<p class="muted">Setting up, checking, upgrading and removing the CodeBurn client. Server: <code>${esc(origin)}</code> &middot; <a href="/">Dashboard</a>${opts.registration ? ' &middot; <a href="/register">Get an install token</a>' : ''}</p>
<nav><ul>
<li><a href="#install">Install and connect</a></li><li><a href="#finish">Finish setup</a></li><li><a href="#sent">What is sent</a></li>
<li><a href="#change">Change what is sent</a></li><li><a href="#check">Check it works</a></li><li><a href="#upgrade">Upgrade</a></li>
<li><a href="#another">Another machine</a></li><li><a href="#logout">Log out or stop</a></li><li><a href="#uninstall">Uninstall</a></li>
<li><a href="#trouble">Troubleshooting</a></li></ul></nav>

<h2 id="install">Install and connect</h2>
${tokenIntro(origin, opts)}
${opts.installers ? `<p>macOS or Linux:</p>${code(lines.unix)}<p>Windows PowerShell:</p>${code(lines.windows)}<p class="muted">The installer needs Node.js 22.13 or newer. It replaces the public <code>codeburn</code> package with this team's build, connects the machine, and shows the sync disclosure without accepting it.</p>` : ''}
<p>${opts.installers ? 'If this build is already installed:' : 'With CodeBurn installed:'}</p>${code(setupCommand(origin, '<token>'))}

<h2 id="finish">Finish setup</h2>
<p>Setup resets your automatic-sync consent, so this step list is part of connecting a machine, not an extra.</p>
${stepList}

<h2 id="sent">What is sent</h2>
<ul>${sent.join('')}</ul>
<p>Prompts, answers and file contents are never sent, and neither are file paths: only the project folder name. The disclosure shown by <code>codeburn sync auto enable</code> lists every field. If you would rather not show a project name to anyone, including admins, sign in to the dashboard and hide it under <em>My profile</em>; its usage then shows as <em>unknown</em>.</p>

<h2 id="change">Change what is sent</h2>
${code(['codeburn sync config detail summary          # or: sessions', 'codeburn sync config findings off', 'codeburn sync config coaching off', 'codeburn sync push --dry-run               # show what would be sent'])}
<p>Sending less takes effect straight away. Sending more pauses automatic sync until you accept it again with <code>codeburn sync auto enable --accept</code>.</p>

<h2 id="check">Check it works</h2>
${code(['codeburn sync status          # endpoint, auth, what is sent, last push', 'codeburn sync auto status     # schedule and recent runs'])}
<p><code>sync status</code> shows <code>Auth: enrollment (team server${config.org_name ? `: ${esc(config.org_name)}` : ''})</code> when the machine is connected.</p>

<h2 id="upgrade">Upgrade</h2>
<p>By default each scheduled sync first installs this server's CLI build when it differs from yours, so you normally do nothing.</p>
${code(['codeburn --version', 'codeburn update                       # install the server build now', 'codeburn sync auto updates           # show whether automatic updates are on', 'codeburn sync auto updates off       # or: on'])}
${opts.installers ? `<p>Or run the installer again, without a token:</p>${code(installerLines(origin, '').unix.replace(/ -s -- --token $/, ''))}${code(installerLines(origin, '').windows.replace(/ -Token $/, ''))}
<p>On a connected machine it asks <em>Do you consent to uploading your AI usage data to the ${esc(teamLabel(config.org_name, origin))} team server?</em> Yes accepts what the new build sends and re-sends your history, so the team's numbers are rebuilt with any new fields:</p>
${code([...REFRESH_COMMANDS])}
<p>No (or no terminal to answer in) changes nothing: run those three commands yourself when you are ready.</p>` : ''}
<p>A new build can change what is sent; if so automatic sync pauses until you run <code>codeburn sync auto enable --accept</code>.</p>

<h2 id="another">Another machine</h2>
<p>Each machine needs its own token. ${opts.registration ? 'Use <em>Set up another machine</em> in the dashboard header (any unused token stops working), then' : 'Ask your admin for a new token, then'} run the install command on that machine and work through <a href="#finish">Finish setup</a>. Your usage from all machines is combined under you.</p>

<h2 id="logout">Log out or stop syncing</h2>
${code(['codeburn sync auto disable      # stop scheduled pushes, keep the connection', 'codeburn sync logout            # revoke this machine on the server and remove its credential'])}
<p>To start again after <code>sync logout</code> you need a new install token.</p>

<h2 id="uninstall">Uninstall</h2>
${code(['codeburn sync auto disable', 'codeburn sync logout', 'npm uninstall -g codeburn'])}
<p>Optionally delete <code>receipts.jsonl</code> from <code>.config/codeburn</code> in your home folder. Usage already sent stays on the server; ask your admin if you want it removed.</p>

<h2 id="trouble">Troubleshooting</h2>
<table>
<tr><th>You see</th><th>Do this</th></tr>
<tr><td>"Automatic sync is paused: what it would send changed"</td><td>Read the disclosure, then <code>codeburn sync auto enable --accept</code>.</td></tr>
<tr><td>401, or the token or device was revoked</td><td>Get a new install token and run <code>codeburn sync setup ${esc(origin)} --token &lt;token&gt;</code>.</td></tr>
<tr><td>Token invalid, expired or already used</td><td>Tokens work once and expire after 7 days. Create a new one.</td></tr>
<tr><td>Nothing in the dashboard yet</td><td>Run <code>codeburn sync push --since all</code>, then <code>codeburn sync auto status</code> to see recent runs.</td></tr>
<tr><td><code>codeburn</code> not found after installing</td><td>Add the npm global bin folder (<code>npm prefix -g</code>, plus <code>/bin</code> on macOS and Linux) to your PATH and open a new terminal.</td></tr>
<tr><td>Node.js too old</td><td>The client needs Node.js 22.13 or newer: <a href="https://nodejs.org/">nodejs.org</a>.</td></tr>
</table>
</main></body></html>
`
}

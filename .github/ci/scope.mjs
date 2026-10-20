import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Only explicitly unrelated areas may skip. Everything unknown runs the full suite.
export function needsChecks(paths) {
  return paths.length === 0 || paths.some(path => !(path.startsWith('docs/') && path.endsWith('.md')));
}

export function scope(eventName, event, git = args => execFileSync('git', args)) {
  // Default-branch pushes, merge queues, manual runs and unknown events always verify fully.
  if (eventName !== 'pull_request') return true;
  try {
    const base = event.pull_request.base.sha;
    const head = event.pull_request.head.sha;
    if (![base, head].every(sha => /^[a-f0-9]{40}$/.test(sha))) return true;
    // Disable rename detection so both old and new paths participate (also handles deletions).
    const names = git(['diff', '--no-renames', '--name-only', '-z', `${base}...${head}`])
      .toString('utf8').split('\0');
    if (names.pop() !== '') return true;
    return needsChecks(names);
  } catch {
    return true; // Missing history, malformed event or failed comparison must never skip checks.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let full = true;
  try { full = scope(process.env.GITHUB_EVENT_NAME, JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH))); }
  catch { /* Safe full verification. */ }
  appendFileSync(process.env.GITHUB_OUTPUT, `full=${full}\n`);
  console.log(full ? 'Full self-hosted server verification required.' : 'Only independent Markdown documentation changed; server work skipped.');
}

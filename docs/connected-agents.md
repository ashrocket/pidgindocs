# Audio replies and connected agents

Open an audio item or the latest briefing and choose **Reply to your agent**. Write a reply or record up to two minutes. Sending saves the response, the original recording, the playback position and an excerpt of the overview transcript. A recording can be saved without transcription.

The reply belongs to the signed-in person. They may address one of their sponsored agents, or leave it for their next available agent. Reading an inbox does not claim the work. One capable runtime must claim it before execution. Saved, claimed, dispatched and completed are separate states.

## Choose the project

**Connect a project** saves a connection for the user's account. Give it a name, choose cloud or local execution, and enter the actual cloud environment ID or absolute local project folder. Context notes can identify the repository, branch, documents and relevant instructions. These notes are copied into each reply.

Select that connection when sending work to a local or cloud session. The server matches both the connection and execution target. A runner for another project cannot claim it. An unscoped reply is available to interactive agents, which can interpret the request within their existing context.

A connection record does not start a service, mint credentials, connect a repository, or grant additional access. The cloud environment must already contain the intended repository and tools. Its account and permissions remain separate from this application.

## Connect Codex explicitly

The included bridge uses the installed Codex CLI. Check `codex exec --help` and `codex cloud exec --help` on the machine that will run it. Verify a cloud environment with a harmless task before enabling automatic pickup: the CLI's cloud interface and the current app's cloud environment interface can differ.

Create a private config file outside the repository:

```json
{
  "url": "https://your-instance.example",
  "target": "cloud",
  "connectionId": "the-uuid-returned-when-you-saved-the-connection",
  "cloudEnvironment": "your-verified-codex-environment-id",
  "cwd": "/absolute/path/to/the/project",
  "stateDir": "/absolute/private/path/to/this-connection-state",
  "name": "Project cloud replies"
}
```

For local execution use `target: "local"`, omit `cloudEnvironment`, and set `cwd` to the saved connection's folder. Each deployment, project and execution target needs its own state directory. Supply `ASSIGNMENT_CREDENTIAL` through your secret manager as `Agent <key>` or `Bearer <key>`; never put a credential in the config, reply, source repository or command argument.

```sh
node scripts/agent-assignments.mjs --config /absolute/private/config.json
node scripts/agent-assignments.mjs --config /absolute/private/config.json --watch
```

The first command makes one bounded check. The second keeps checking while that process is available. Neither installs a background service. Cloud work can continue after submission; a machine running this bridge must be available to submit new replies. A closed chat or sleeping bridge cannot be woken by a saved reply.

The bridge advertises text capability. A voice-only reply remains queued for an agent that can use audio. Dictated or typed text can accompany the original recording. No automatic transcription service or secret is configured by this bridge.

Local sessions run in a Codex worktree with the workspace-write sandbox. Cloud sessions use the explicitly configured environment. Replies are passed as data through process arguments or stdin; no shell evaluates their contents. The overview transcript is reference material and does not expand the agent's permissions.

## Other agents and recovery

MCP clients can use `pidgin_list_agent_connections`, `pidgin_register_agent_runtime`, `pidgin_list_assignments`, `pidgin_get_assignment`, `pidgin_claim_assignment` and `pidgin_update_assignment`. Managed products map their usual tool prefix. Agent inboxes include durable assignments alongside informational board items.

Register real capabilities and heartbeat every 60 seconds. A registration expires after 120 seconds. A claim has a 300-second lease. Renew while working, defer work that cannot be performed, and record dispatch before starting an external session. Only the original claimant can reconcile a dispatched assignment. An expired claim can be picked up again; dispatched work is never automatically relaunched.

The private bridge journal distinguishes an uncertain dispatch from a confirmed result. A lost completion acknowledgement is retried using the saved answer. Other uncertain states require inspection of the saved session and execution log. Do not delete the journal to force another run. The cloud bridge records the cloud task reference; it does not automatically import the cloud task's final answer. Reconcile that task and complete the assignment with its actual result using the original claim.

Apply the core migration before enabling these routes. Server tests cover account and agent isolation, retries, atomic claims, revoked access, recording limits, project matching and HTTP/MCP behavior. The runner's Node tests use fake execution and do not prove a live Codex submission.

# Audio replies and connected-agent assignments

**Goal:** Let a person respond to an audio overview with text or a recording, deliver that response to a capable connected agent, and retain it for the agent's next assignment check when immediate execution is unavailable.

**Context:** Audio storage, scoped agent identities, MCP, and event delivery already exist. The board inbox is informational and provides no durable work ownership. The shared core is imported into managed Solo and Teams. Local Codex supports `exec` and `cloud exec`; cloud submission needs a configured environment. The paired Intel worker is currently unreachable.

**Constraints:** Keep each deployment's credentials and content separate. Shared changes originate in PidginCore. Preserve the original recording without requiring transcription. Never treat queueing or dispatch as completion. Agents receive only their sponsor's replies, optionally narrowed to one agent. Runtime capabilities do not grant authority. No arbitrary webhook URLs, shell commands supplied by replies, or automatic execution without a deliberately connected runtime. All web copy has English, Russian, Swedish, and Spanish catalog entries. Preserve unrelated dirty worktrees.

**Done when:** Audio players accept text and voice, show saved task/result state, and preserve playback context. Agents discover assignments through MCP/inbox and can claim, renew, defer, dispatch, and complete them. A configured Codex bridge sends eligible work to a local session or configured cloud environment. Offline or incapable agents leave durable pending work. PidginCore, Duva Solo, and Duva Teams pass the relevant checks and the enabled deployment is verified.

**Verification required:** Real D1 tests for ownership, retries, capability matching, expired claims, concurrent claims, revoked credentials and completed results; HTTP/MCP parity; voice persistence and size limits; bridge tests with a fake executable proving command arguments, no duplicate dispatch, and failure recovery; browser checks of text/voice and result state; Duva server checks, core pin/bundle checks, and both Apple schemes if modified. Verify exact deployment and live behavior separately from commits.

## Design decisions

Use a database queue with optional connected runtimes. Push-only delivery loses work when a session closes; a queue-only system omits the requested immediate local/cloud handoff. Each accepted reply therefore creates one immutable input and one assignment. A retry key detects exact retries and rejects changed content. Voice bytes live in private R2 with their hash/metadata in D1; text, context and all task state live in D1. Agents fetch voice only after authorization.

Runtime registration advertises execution location and accepted modalities with a short heartbeat expiry. Claims use an atomic conditional UPDATE and a secret lease token. A queued/expired task may be claimed only by a compatible, authorized runtime. Once an external launch starts, dispatch is recorded as a separate state; an uncertain launch is retained for reconciliation rather than launched twice. Completion carries the agent's answer and optional session reference. The human player can read that result. Agents without a persistent bridge still find the tasks on their next MCP inbox/check.

## Tasks

- [x] Add `core/assignments/{store,routes,mcp}.ts` and a core migration for replies, assignments and runtime capabilities. Add D1 tests before implementation; run focused tests and TypeScript.
- [x] Wire HTTP routes, MCP tools, the board inbox and agent instructions. Test owner/API/agent credential behavior and revocation, including prefix mapping in Duva.
- [x] Add a portable Codex assignment bridge with explicit local/cloud configuration and a durable launch journal. Test registration, dispatch, completion, deferral and uncertain-launch reconciliation with fake processes.
- [x] Add a shared audio reply component, recording capture and visible status/results to web audio/commute players. Integrate Duva catalogs and the native audio player. Test voice without transcription and request retry behavior.
- [ ] Import the committed public core into Duva, carry migration and tests through the managed assemblies, update connection guidance and run required checks. Review the complete diff with a fresh reviewer.
- [ ] Publish reviewable branches, inspect CI, enable through the correct release paths, and verify real saved replies and agent pickup. Publish one private handoff at the terminal outcome.

## Review focus

- Two sessions claim the same response: one winner, stale lease updates refused.
- A request is retried after its response was lost: same task, no duplicate recording or execution.
- An agent is revoked or belongs to someone else: no content, voice download, or task mutation.
- A recording has no transcript: saved and offered only to a runtime that can accept voice.
- A runtime crashes after launching cloud/local work: visible uncertain dispatch, no blind relaunch.

## Progress

- 2026-11-27: Inspected current main in both repositories and created isolated feature worktrees. No previous implementation for audio responses exists. Local Codex CLI supports local and cloud submission. Intel worker probe failed DNS resolution; tests will run locally with bounded parallelism.
- 2026-11-27: The owner selected a personal cloud configuration for the first trial. Added user-owned project connections, matching runtime registration and immutable context snapshots. Thirteen focused D1 tests and five bridge tests pass; the full conformance run had 675 passes and one timeout, and that file passed on focused rerun (48 tests with assignments).
- Cloud account setup is pending: current-app environment compatibility still needs a real submission check. Computer Use became unavailable after detecting another browser controller. No environment, production connection or live runner has been created.
- 2026-11-27: Both managed Apple schemes build successfully. Managed native-session submission, scoped claim, completion and isolation pass through the real Worker entry. The shared-core and Solo bundle boundaries pass; 6,120 stored interface labels have all required translations; six bridge tests pass. Full managed server verification and final review are pending.
- Ruling: The bridge advertises text capability. Voice-only replies remain saved for a voice-capable agent; native on-device transcription is optional. No platform transcription service or provider credential is introduced.
- Ruling: A cloud submission receipt identifies the task but is not its final answer. The bridge retains dispatch state and exposes a task link; automatic result import is not enabled. The original dispatcher must reconcile the actual result.
- Ruling: User cloud setup remains separate from implementation. The browser-control service is unavailable; a prior competing browser controller does not establish that Chrome is now free. Do not enable a fabricated or unverified environment ID.
- Final review: one independent whole-branch review identified three Important bridge recovery failures, with no Critical or Minor findings. All three were reproduced, then fixed: queue progress past abandoned journals, claim contention and transient-outage recovery, and republishing a saved cloud receipt without resubmission. Four added regression tests changed from failing to passing; the full bridge suite passes 10/10.
- Final: Ruling: Live cloud compatibility, browser microphone behavior, physical-device recording and deployment migrations were not judged by the reviewer because they require runtime evidence. They remain explicit release gates; successful unit tests do not establish these outcomes.
- Verification limitation: the full managed server run hit the host open-file limit and was stopped (exit 130). Broad verification moves to GitHub CI. The older advertised-tool count assertion was updated for the six new tools; its focused rerun is still required.

# Persistent task goals

For a complex request, the agent can call `goal_create` with a title, observable success criteria and up to 20 steps. The server retains the originating request. One active, paused or blocked goal may exist per bot. A new call returns existing open work instead of silently replacing it.

The goal card sits directly above the message composer. It stays collapsed until expanded. It shows progress and current state, with step evidence and a task checkpoint available on expansion. Web, Electron and mobile use the same API and durable records. Cards recover after refresh; updates are polled only while the app is visible.

## Progress and verification

Use `goal_status` to obtain step IDs and the current revision. `goal_update` can mark a step working, verifying, done, blocked or cancelled, append steps for additional work, and update the checkpoint. Keep environment, constraints, verified outcomes and pending questions there. The checkpoint is injected on later private turns as historical data; it never grants permission or overrides new user instructions.

Only one step may be working. A done step requires a note and a named verification tool that succeeded in the same run after the previous goal update. The server records the actual completion event ID. This proves the verification tool ran successfully, not that the model's interpretation is correct. Goal completion requires all steps done. Existing tool approval and sandbox rules still apply.

## Pursuit and controls

If a model ends its response after updating an active goal, the runtime can request up to three additional continuations using the same agent and existing tool budget. Completed, paused, blocked or unrelated goals are not automatically chased. Provider failures, approval pauses and cancellation stop continuation. Exhaustion leaves the goal blocked, never falsely completed.

Pause/Stop cancel the bot's current run. Pause keeps the checkpoint resumable; Stop ends the goal. Resume is an explicit user action that sends a new chat request. Revision checks prevent duplicate resumes and stale controls from overwriting newer state. Cancelled runs leave active goals paused; failed or prematurely completed runs leave them blocked. Restarted workers retain the saved steps and checkpoint.

This is bounded foreground task pursuit, not a recurring scheduler. It does not keep running indefinitely after a time/token limit or wake itself later. Existing schedules remain separate.

## Verification

Offline tests cover evidence requirements, owner/space isolation, stale writes, duplicate goals, paused-goal protection, hard continuation limits, cancellation recovery, collapsed card rendering and persisted card recovery.

Broader history-window selection, compaction policy and automatic historical evidence retrieval remain separate work; a task checkpoint addresses continuity for goals but does not replace that pipeline.

# Routine output workspace

New scheduled and manual routine executions create independent threads. The task and run reference that thread; the teammate's direct chat and group transcripts receive no automatic routine messages. This also keeps routine execution context out of normal conversation history. Routines retain their prompt, assigned teammate, schedule, model settings, and existing notification preference.

The web/Electron sidebar lists routines across the selected space. Each routine opens a workspace with its schedule, editable instructions, run history, output, tool activity, artifacts, charts, approvals, and cloud-agent cards. Running output refreshes every two seconds while visible. Navigation links preserve both routine and selected run. Users can pause/resume the schedule, run manually, edit, delete, answer requests, and stop an isolated execution.

New routines created through the interface default to notifications off. The routine's notification preference controls the existing notification service independently of its teammate's preference. Reminders created with an explicit notification preference retain it. Run-status indicators expose running, failed, and paused state in the sidebar.

## API

- `routines.all`: owner-scoped routine list in the selected space, with latest run status.
- `routines.history`: existing paginated history; output links now open the routine workspace.
- `routines.output`: owner-scoped transcript and recent events for one routine run. Messages are additionally filtered by run ID so legacy runs that shared a chat cannot expose unrelated output. Older transcript pages are available through `before`.
- `routines.answerRun`: resolves a pending request using its owning run's thread and existing approval machinery.
- `routines.stopRun`: stops only an isolated routine thread through the normal cancellation and sandbox teardown flow. Legacy runs sharing a chat must be stopped from their original chat.

Manual start idempotency locks the routine before checking its client nonce. A retried start cannot create a second run just because each execution has a different thread.

## Compatibility

The routine-output-thread migration adds an explicit routine owner to Thread and extends its existing single-owner constraint. Deleting a routine also deletes its run history through these owned threads. Existing routine output remains in its original chat and is also readable through routine history. Existing schedules and explicit notification settings are preserved. The mobile routine-history reader continues to show run status; its old chat link is omitted for isolated runs until it gains a dedicated output view. Failures-only notification policies and explicitly publishing a result back to chat are future extensions.

The local Compose source override mounts the edited API/contracts/executor and built frontend, so recreating local containers preserves these changes.

### Local smoke-test result
The UI-created manual run was stored in a separate routine-owned thread. Main-chat message count stayed at 101. The sandbox could not start because Docker Desktop presents bind-mounted files with the inspecting container user's ownership; the root supervisor's ownership preflight rejected the uid-1000 home. The test run was cancelled through the new workspace control. Automated tests, typechecks and the frontend build passed; model-output end-to-end verification remains pending this local environment repair. No supervisor identity or Docker-socket group change was applied.

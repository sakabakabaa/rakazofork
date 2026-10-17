# Run performance diagnostics

Worker logs emit one `agent.model.call.completed` record per provider request. Each record
includes `runId`, `callId`, provider/model, operation kind, `startedAt`, provider-stream
`durationMs`, `timeToFirstEventMs`, outcome, token/cache counts when reported, and subagent ID
when applicable. The duration starts after context preparation and ends when the provider stream
terminates; it excludes tool execution and usage-ledger settlement. Missing provider token counts
remain null at the per-call level and are excluded from the aggregate sums.

Tool executions already produce durable `agent.tool.called` and `agent.tool.completed` events.
The completion payload and matching worker log include the tool name, execution ID, duration,
and outcome. Browser and Playwright tools therefore show their own elapsed execution time.
Run `startedAt` and `completedAt` provide the end-to-end wall time. All records correlate by
`runId`; model calls and tool calls also have their own IDs.

Each runtime invocation also emits `agent.runtime.performance.completed` with wall duration,
model call count/errors/duration, average time to first event, reported token totals, tool
call count/errors/duration, and any configured tool-call fuse state. These aggregates make it
possible to tell whether model latency, tool work, or failures dominate without manually
aggregating every per-call record. A runtime invocation can be one worker segment of a longer
resumed run; use the same `runId` to combine its segments with the durable run events. Aggregate
token values remain null when no provider call reported that token category.

For the local Compose stack, inspect recent worker records with:

```sh
docker compose -p rakazo-local --env-file .env -f infra/compose/docker-compose.yml logs --since 15m worker \
  | grep -E 'agent\.(model\.call|tool)\.completed'
```

To focus on one run, append `| grep '<run-id>'` using the run ID shown in the app. The records
contain timings and identifiers only; they do not include prompts, page contents, tool arguments,
or tool results.

Interpretation:

- High `timeToFirstEventMs` points to provider/network/model startup latency.
- Low time-to-first-event but high model `durationMs` points to slow generation or a long streamed
  response.
- High browser/Playwright tool duration points to navigation, page loading, or browser automation.
- Long gaps between model/tool records point to orchestration, database, or local queue delays.
- High model-call counts with individually modest durations point to repeated reasoning/tool
  cycles; check whether independent reads or browser actions could have been batched.
- High `toolErrors` or repeated calls to the same failing tool point to retry loops or an external
  access problem.

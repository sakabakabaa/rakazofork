# Task quality loop and benchmark

Complex turns should establish the requested outcome and observable checks, execute the work, and verify material results with the relevant tool. A tool attempt is not completion evidence. Final answers should separate verified outcomes from blocked or unverified work. Simple questions do not need a formal plan, and private reasoning stays private.

Tool descriptions now clarify what the result means, when a second verification step is needed, how web search differs from fetching a source, and what to do after blocked or failed retrieval. Web-tool errors include a bounded recovery suggestion so the model can change approach once instead of repeating the same failing call.

## Run the representative quality suite

The `quality` suite covers artifact creation, structured file transformation, a terminal-to-file verification workflow, seeded web research, persistent agent creation, and a multi-turn follow-up. It uses a disposable Postgres container, fake computer/connectors, and a seeded offline web provider. Only inference calls go to the configured model provider; benchmark fixture data never makes external web or connector calls.

```sh
pnpm test:evals -- --suite quality --list
pnpm test:evals -- --live --suite quality --provider "$EVAL_PROVIDER" --model "$EVAL_MODEL" --api-key-env EVAL_API_KEY --pricing /path/to/model-pricing.json --trials 3 --output /tmp/rakazo-quality.json
```

Set the named API-key environment variable before running the benchmark. The pricing JSON must provide `source`, `version`, and USD-per-million `input`, `output`, `cacheRead`, and `cacheWrite` rates. Never put a key directly in the command line or check reports into source control. Use `--case <id>` to isolate a case and `--spend-cap-usd` to bound inference spend. `product` still runs the full established suite, and `history` covers large-history recall/follow-up stress cases. Live runs use disposable PostgreSQL via Testcontainers, so Docker must be available.

## Report interpretation

Each case records pass/fail against explicit outcome criteria, first response time, total latency, model calls, cost/tokens when available, tool calls, failed tool calls, and retries. A retry is a later invocation of the same tool in the same run after that tool emitted an error. It is a diagnostic signal, not automatically a failure: the case outcome still determines correctness. Compare the same case fixtures, trial count, model/provider settings, and code revision across runs. Keep reports local because they can contain model-generated task output, though the harness redacts common secret patterns.

The browser benchmark checks search, source fetch, factual grounding, and link inclusion against a seeded page. It does not claim to measure live web quality, browser rendering/perception, or real-world site reliability. The terminal benchmark permits only one exact harmless `echo` command in the fake sandbox; all other arbitrary shell commands remain unavailable in offline evals.

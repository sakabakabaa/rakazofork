# CLI coder activity

The web and Electron computer sidebar includes a Coder panel below the screen preview. Ask the agent to use DSH, or explicitly ask it to call `coder_run` with a task and working directory. The first supported CLI is DSH; Codex and Claude CLI protocols are not implemented by this runner.

The CLI must already be installed in the agent computer. `executable` can select an installed DSH wrapper when it is not on PATH. `profile` defaults to `headless`. Relative `cwd` paths use the bot workspace; absolute paths refer to directories inside the sandbox. DSH keeps its own provider/model configuration; saved command credentials are injected through the same path as the shell tool. The tool is unavailable when disabled and also refuses execution when shell access is disabled.

The runner invokes DSH with JSONL output directly, waits for process exit, and sends redacted structured activity through the existing authenticated computer-command event feed. It does not create background log files or ask the parent model to poll. The parent receives a compact summary and exit status.

The panel is collapsed initially, shows the latest action and elapsed time, and expands to show up to 60 recent child actions, with bounded output previews and final text. Refresh restores activity from the existing command history window. A three-second recovery refresh supplements live events. Stop run uses the existing parent-run cancellation and process teardown; it stops the parent as well as its CLI work. Mobile keeps the normal tool-call/final-response view; this computer sidebar is specific to web and Electron.

CLI output is rendered as text, never executable HTML. Secret redaction happens both on the process output and on decoded JSON strings. Existing command timeouts, workspace resolution, approval checks, and cancellation remain in effect.

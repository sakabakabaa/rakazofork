import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  realSandboxTimeout,
  rpc,
  signup,
} from "./helpers";

/** Keep the panel's screen preview off the network; these tests only drive the rail. */
async function stubScreen(page: Page) {
  const screenUrl = "https://screen.example/vnc.html";
  await page.route("https://screen.example/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Test desktop</title><body style='margin:0;background:#3a4a5a'>",
    }),
  );
  await page.route("**/rpc/computer/screenUrl", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { url: screenUrl } }),
    }),
  );
}

/** The destination rail only renders while a bot's panel is open, so make sure one is. */
async function openBotPanel(page: Page) {
  const panel = page.getByTestId("side-panel");
  if ((await panel.getAttribute("data-panel")) === "closed") {
    await page.getByTitle("Agent computer").click();
  }
  await expect(panel).not.toHaveAttribute("data-panel", "closed");
  return panel;
}

/**
 * Switch the side panel to a rail destination. Selecting the open destination would close
 * the panel, so only click when it is showing something else.
 */
async function showDestination(page: Page, name: "Computer" | "Terminal" | "Files") {
  const id = name.toLowerCase();
  const panel = await openBotPanel(page);
  const button = panel.getByTestId("right-panel-rail").getByRole("button", { name, exact: true });
  // Files and the terminal need a running computer; the rail stays disabled until then.
  await expect(button).toBeEnabled({ timeout: realSandboxTimeout(90_000, 30_000) });
  if ((await panel.getAttribute("data-panel")) !== id) await button.click();
  await expect(panel).toHaveAttribute("data-panel", id);
  await expect(button).toHaveAttribute("aria-pressed", "true");
  return panel;
}

test("the side panel browses, uploads, and downloads files over the screen", async ({
  page,
}, testInfo) => {
  await signup(page, `workspace-${Date.now()}@rakazo.test`, "password12", "Workspace");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "computer/boot", { botId });
  // The intro run may still hold the computer; control is granted once it finishes.
  await expect
    .poll(
      () =>
        rpc(page, "computer/takeover", { botId }).then(
          () => true,
          () => false,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  await rpc(page, "computer/uploadFile", {
    botId,
    path: "reports/q3.txt",
    contentBase64: Buffer.from("Q3 draft\n").toString("base64"),
  });
  await stubScreen(page);

  // Opening the panel refreshes the thread, so it sees both the running computer and the
  // control taken above; uploading needs control.
  const panel = await showDestination(page, "Files");
  const files = panel.getByTestId("computer-files");
  await files.getByRole("button", { name: /^reports/ }).click();
  await expect(files.getByText("~/reports", { exact: true })).toBeVisible();
  await expect(files.getByRole("button", { name: /^q3\.txt/ })).toBeVisible();
  await files.getByRole("button", { name: "Back" }).click();
  await expect(files.getByText("~/", { exact: true })).toBeVisible();
  // Changes made elsewhere (a shell, the bot) appear without reopening the destination.
  await rpc(page, "computer/uploadFile", {
    botId,
    path: "made-in-shell.txt",
    contentBase64: Buffer.from("x").toString("base64"),
  });
  await expect(files.getByRole("button", { name: /^made-in-shell\.txt/ })).toBeVisible({
    timeout: 10_000,
  });

  // Uploading needs control, so the button only exists once the panel sees the takeover.
  await expect(files.getByRole("button", { name: "Upload" })).toBeVisible({
    timeout: realSandboxTimeout(90_000, 30_000),
  });
  await files.locator('input[type="file"]').setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Quarterly numbers checked.\n"),
  });
  await files.getByRole("button", { name: /^notes\.txt/ }).click();
  await expect(files.getByText("Quarterly numbers checked.")).toBeVisible();
  const download = page.waitForEvent("download");
  await files.getByRole("button", { name: "Download" }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe("notes.txt");
  expect(await readFile((await saved.path())!, "utf8")).toBe("Quarterly numbers checked.\n");

  await showDestination(page, "Terminal");
  const terminal = page.getByTestId("computer-terminal");
  await expect(terminal).toBeVisible();
  // Holding control adds an interactive shell beside the bot's activity. The fake computer
  // answers through the same capability, web proxy, websocket, and frame protocol.
  await panel.getByRole("tab", { name: "Shell" }).click();
  const shell = page.getByTestId("computer-shell");
  await expect(terminal).toBeHidden();
  await expect(shell).toContainText("$");
  // Click near the pane's corner: the panel's resize edge can sit over the middle.
  await shell.click({ position: { x: 24, y: 24 } });
  await page.keyboard.type("echo hallo-shell");
  await page.keyboard.press("Enter");
  await expect(shell).toContainText(/\$ echo hallo-shell\s*hallo-shell/);
  await page.keyboard.type("stty size");
  await page.keyboard.press("Enter");
  // The panel is narrower than a default 80-column terminal, so this proves resize frames arrive.
  await expect
    .poll(async () => {
      const size = /\$ stty size\s*(\d+) (\d+)/.exec((await shell.textContent()) ?? "");
      return size ? Number(size[2]) : null;
    })
    .toBeLessThan(80);
  await captureScreenshot(page, testInfo, "computer-terminal-shell");

  // The shell stays connected while the Activity tab is shown.
  await panel.getByRole("tab", { name: "Activity" }).click();
  await expect(terminal).toBeVisible();
  await panel.getByRole("tab", { name: "Shell" }).click();
  await expect(shell).toContainText("hallo-shell");
  // A dropped connection gets a fresh shell instead of a dead pane.
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  await expect(shell).toContainText(/\[closed\]\s*\$/);
  await page.keyboard.type("echo wieder-da");
  await page.keyboard.press("Enter");
  await expect(shell).toContainText(/\$ echo wieder-da\s*wieder-da/);
  await panel.getByRole("tab", { name: "Activity" }).click();
  await captureScreenshot(page, testInfo, "computer-workspace");

  // The rail switches destinations. The file browser reads the computer again instead of
  // holding a closed window's state, so the uploaded file is still listed.
  await showDestination(page, "Computer");
  await expect(files).toBeHidden();
  await showDestination(page, "Files");
  await expect(
    panel.getByTestId("computer-files").getByRole("button", { name: /^notes\.txt/ }),
  ).toBeVisible();

  await panel.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(panel).toHaveAttribute("data-panel", "closed");
  await expect(page.getByTestId("right-panel-rail")).toHaveCount(0);

  // Control can end while the computer stays open (released, expired, or handed back for
  // maintenance). The terminal then offers to take control again instead of a dead shell.
  await rpc(page, "computer/release", { botId });
  // Reopening the Computer destination refreshes the thread, so the panel sees the release.
  const refreshed = page.waitForResponse(
    (response) => response.url().includes("/rpc/threads/get") && response.ok(),
  );
  await showDestination(page, "Computer");
  await refreshed;
  await showDestination(page, "Terminal");
  const openShell = panel.getByRole("button", { name: "Open shell" });
  await expect(openShell).toBeVisible({ timeout: realSandboxTimeout(90_000, 30_000) });
  await expect(panel.getByRole("tab", { name: "Shell" })).toHaveCount(0);
  // Taking control from the panel opens the full window, where the shell lives. Wait for
  // control to arrive there: the window opens before the takeover finishes.
  await openShell.click();
  await expect(page.getByText("You have control").first()).toBeVisible({
    timeout: realSandboxTimeout(90_000, 30_000),
  });
  await page.getByRole("button", { name: "Close computer" }).click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeHidden();
  await showDestination(page, "Terminal");
  await panel.getByRole("tab", { name: "Shell" }).click();
  await expect(page.getByTestId("computer-shell")).toContainText("$", { timeout: 30_000 });
});

test("the terminal shows the bot's shell commands and file actions live and after reopening", async ({
  page,
}, testInfo) => {
  await signup(page, `terminal-feed-${Date.now()}@rakazo.test`, "password12", "Terminal Feed");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "computer/boot", { botId });
  await stubScreen(page);
  await showDestination(page, "Terminal");

  const terminal = page.getByTestId("computer-terminal");
  await expect(terminal).toBeVisible();
  // Poll the send: the intro run may still be finishing when the test starts.
  await expect
    .poll(
      () =>
        rpc(page, "threads/send", {
          botId,
          text: "run the shell command echo terminal-feed-ok",
        }).then(
          () => true,
          () => false,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect(terminal).toContainText("$ echo terminal-feed-ok", { timeout: 30_000 });
  await expect(terminal).toContainText(/terminal-feed-ok\s*$/m);
  // A command's running and done events render as one entry.
  await expect
    .poll(async () => ((await terminal.textContent()) ?? "").split("$ echo").length - 1)
    .toBe(1);
  // The shell line is live before that run finishes. Sending now would queue
  // steering, and the scripted continuation would not run the file request.
  await expect
    .poll(
      async () =>
        (await rpc<{ run: { status: string } | null }>(page, "threads/get", { botId })).run
          ?.status ?? "idle",
      { timeout: realSandboxTimeout(90_000, 30_000) },
    )
    .toBe("idle");
  // File tools show up too, not only shell commands.
  await expect
    .poll(
      () =>
        rpc(page, "threads/send", {
          botId,
          text: "write a file called feed-note.txt that says hallo",
        }).then(
          () => true,
          () => false,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect(terminal).toContainText("Wrote feed-note.txt", { timeout: 30_000 });
  await captureScreenshot(page, testInfo, "computer-terminal-bot-feed");

  // The feed is rebuilt from the computer's command history when the destination reopens.
  await showDestination(page, "Computer");
  await expect(page.getByTestId("computer-terminal")).toBeHidden();
  await showDestination(page, "Terminal");
  await expect(page.getByTestId("computer-terminal")).toContainText("$ echo terminal-feed-ok");
  await expect(page.getByTestId("computer-terminal")).toContainText("Wrote feed-note.txt");
});

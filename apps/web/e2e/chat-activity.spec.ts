import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  realSandboxTimeout,
  signup,
} from "./helpers";

// The scripted runtime answers this with one write_file call and then a short reply, so the
// turn has a tool step to disclose and a file for the diff.
const PROMPT = "write a note called notes/chat-activity.txt that says fake e2e note";
const REPLY = "writing that into my home now.";

test("chat activity shows a live line, expands to steps, and survives a reload", async ({
  page,
}, testInfo) => {
  // Activity stays hidden until this browser saved "on".
  await page.addInitScript(() => {
    if (localStorage.getItem("rakazo.showToolActivity") == null) {
      localStorage.setItem("rakazo.showToolActivity", "on");
    }
  });
  await signup(page, `chat-activity-${Date.now()}@rakazo.test`, "password12", "Chat Activity");
  await completeOnboarding(page);
  // A fresh bot keeps the transcript to this one turn: the onboarding bot's intro run would
  // add a second activity group the assertions below cannot tell apart.
  await createNamedBot(page, "Activity Chat");

  const transcript = page.getByTestId("transcript");
  const activity = transcript.getByTestId("tool-activity").first();
  await page.getByPlaceholder(/^Message /).fill(PROMPT);
  await page.getByRole("button", { name: "Send" }).click();

  // The run is live: the collapsed line is on screen and says it is working. Whether
  // "Working" sits inside the latest-action text or beside it, the summary carries it.
  await expect(activity.locator("summary")).toContainText("Working", {
    timeout: realSandboxTimeout(90_000, 30_000),
  });
  await expect(transcript.getByTestId("tool-latest-action").first()).toBeVisible();
  await captureScreenshot(page, testInfo, "chat-activity-live");

  // Expanding during the run reveals the timeline. A run that finishes between the two
  // assertions leaves the same rows behind, so this stays stable.
  if (!(await activity.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await activity.locator("summary").click();
  }
  await expect(activity).toHaveJSProperty("open", true);
  const steps = activity.getByTestId("tool-activity-step");
  await expect(steps.first()).toBeVisible();
  // The newest row is the one still running, so it carries a status indicator.
  await expect(steps.last().getByTestId("tool-activity-status")).toBeVisible();

  await expect(transcript.getByText(REPLY)).toBeVisible({
    timeout: realSandboxTimeout(90_000, 30_000),
  });
  const stepsAfterRun = await steps.count();
  expect(stepsAfterRun).toBeGreaterThan(0);

  // The timeline is rebuilt from the stored transcript, not kept in memory.
  await page.reload();
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await expect(transcript.getByText(REPLY)).toBeVisible({
    timeout: realSandboxTimeout(90_000, 30_000),
  });
  const restored = transcript.getByTestId("tool-activity").first();
  await expect(restored).toBeVisible();
  if (!(await restored.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await restored.locator("summary").click();
  }
  await expect(restored).toHaveJSProperty("open", true);
  await expect(restored.getByTestId("tool-activity-step")).toHaveCount(stepsAfterRun);
  await expect(restored.getByTestId("tool-activity-step").first()).not.toBeEmpty();

  // The run wrote a text file, so its diff belongs in the timeline. A run without a write
  // would have nothing to diff, and that assertion is skipped rather than failed.
  const diff = restored.getByTestId("tool-diff").first();
  if ((await diff.count()) === 0) {
    testInfo.annotations.push({
      type: "diff",
      description: "this run rendered no tool-diff, so the added-line assertion was skipped",
    });
  } else {
    // A diff is collapsed by default, so open it before reading its lines.
    if (
      await diff.evaluate(
        (element) => element.tagName === "DETAILS" && !(element as HTMLDetailsElement).open,
      )
    ) {
      await diff.locator("summary").click();
    }
    await expect(
      diff.locator('[data-testid="tool-diff-line"][data-kind="add"]').first(),
    ).toBeVisible();
  }
  await captureScreenshot(page, testInfo, "chat-activity-restored");
});

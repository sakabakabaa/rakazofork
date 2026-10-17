// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RailEntry, RightPanelRail } from "./RightPanelRail";

const entries: RailEntry[] = [
  { id: "computer", label: "Computer", icon: <span>c</span> },
  { id: "terminal", label: "Terminal", icon: <span>t</span> },
  { id: "files", label: "Files", icon: <span>f</span>, unavailable: "Start the computer first" },
];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

function mount(element: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return { host, root };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("right panel rail", () => {
  it("marks the open panel and reports selections", () => {
    const onSelect = vi.fn();
    const { host } = mount(
      <RightPanelRail entries={entries} active="terminal" onSelect={onSelect} />,
    );

    const buttons = [...host.querySelectorAll("button")];
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Computer",
      "Terminal",
      "Files",
    ]);
    expect(buttons[1]?.getAttribute("aria-pressed")).toBe("true");
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("false");

    act(() => buttons[0]!.click());
    expect(onSelect).toHaveBeenCalledWith("computer");
  });

  it("disables an unavailable destination and says why in the tooltip", () => {
    const onSelect = vi.fn();
    const { host } = mount(<RightPanelRail entries={entries} active={null} onSelect={onSelect} />);

    const files = [...host.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Files",
    )!;
    // A hidden entry reads as a bug; a disabled one explains what would enable it.
    expect(files.disabled).toBe(true);
    expect(files.getAttribute("title")).toBe("Start the computer first");
    act(() => files.click());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders nothing when there is no destination", () => {
    // A group thread has no workspace surfaces, so the rail must not claim any.
    const html = renderToStaticMarkup(
      <RightPanelRail entries={[]} active={null} onSelect={() => {}} />,
    );
    expect(html).not.toContain("<button");
  });
});

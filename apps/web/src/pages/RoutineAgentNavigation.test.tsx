// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ list: vi.fn(), all: vi.fn() }));
vi.mock("../lib/rpc", () => ({ rpc: { routines: api } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { RoutinesNavigation } from "./RoutinesWorkspace";

afterEach(() => vi.clearAllMocks());
it("scopes routine requests and hides stale results on agent switch", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const a = { id: "routine-a", botId: "bot-a", name: "Agent A routine", active: true };
  const b = { id: "routine-b", botId: "bot-b", name: "Agent B routine", active: true };
  let finishB!: (rows: object[]) => void;
  api.list.mockImplementation(({ botId }) =>
    botId === "bot-a"
      ? Promise.resolve([a, b])
      : new Promise((resolve) => {
          finishB = resolve;
        }),
  );
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(<RoutinesNavigation botId="bot-a" onOpen={vi.fn()} />));
    expect(element.textContent).toContain(a.name);
    expect(element.textContent).not.toContain(b.name);
    await act(async () => root.render(<RoutinesNavigation botId="bot-b" onOpen={vi.fn()} />));
    expect(element.textContent).not.toContain(a.name);
    await act(async () => finishB([b]));
    expect(element.textContent).toContain(b.name);
    expect(api.list).toHaveBeenCalledWith({ botId: "bot-b" }, expect.anything());
    expect(api.all).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

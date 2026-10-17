import { describe, expect, it } from "vitest";
import {
  getToolActivityEnabled,
  normalizeToolActivityPreference,
  persistToolActivityPreference,
  resolveToolActivityPreference,
  TOOL_ACTIVITY_STORAGE_KEY,
} from "./tool-activity-preference";

describe("tool activity preference", () => {
  it("shows activity by default unless the user explicitly turns it off", () => {
    expect(normalizeToolActivityPreference("on")).toBe("on");
    expect(normalizeToolActivityPreference("ON")).toBe("on");
    expect(normalizeToolActivityPreference(" on ")).toBe("on");
    expect(normalizeToolActivityPreference("off")).toBe("off");
    expect(normalizeToolActivityPreference("OFF")).toBe("off");
    expect(normalizeToolActivityPreference(null)).toBe("on");
    expect(normalizeToolActivityPreference(undefined)).toBe("on");
    expect(normalizeToolActivityPreference("")).toBe("on");
    expect(normalizeToolActivityPreference("nonsense")).toBe("on");
  });

  it("resolves from an explicit stored value", () => {
    expect(resolveToolActivityPreference({ stored: "off" })).toBe("off");
    expect(resolveToolActivityPreference({ stored: "on" })).toBe("on");
    expect(resolveToolActivityPreference({ stored: null })).toBe("on");
  });

  it("persists through storage helpers and reads it back", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
    persistToolActivityPreference("off", storage);
    expect(store.get(TOOL_ACTIVITY_STORAGE_KEY)).toBe("off");
    expect(resolveToolActivityPreference({ storage })).toBe("off");
    persistToolActivityPreference("on", storage);
    expect(resolveToolActivityPreference({ storage })).toBe("on");
  });

  it("uses the default when storage is unreadable or throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(resolveToolActivityPreference({ storage: throwing })).toBe("on");
    expect(resolveToolActivityPreference({ storage: null })).toBe("on");
    expect(() => persistToolActivityPreference("off", throwing)).not.toThrow();
  });

  it("enables the collapsed action summary by default", () => {
    expect(getToolActivityEnabled()).toBe(true);
  });
});

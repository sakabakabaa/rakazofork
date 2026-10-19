import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import {
  filterImageReturningComputerTools,
  IMAGE_RETURNING_COMPUTER_TOOLS,
  MODEL_CANNOT_SEE_MESSAGE,
  modelAcceptsImageInput,
  modelIdSupportsImages,
  resolveModelRefForVisionCheck,
  updateModelImageCapabilities,
} from "./model-vision.js";

describe("model vision gating for computer tools", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("treats catalog text-only models as unable to see", () => {
    expect(modelAcceptsImageInput("openrouter", "deepseek/deepseek-v4-flash-0731")).toBe(false);
    expect(modelAcceptsImageInput("openrouter", "deepseek/deepseek-v4-pro")).toBe(false);
  });

  it("treats catalog vision models as able to see", () => {
    expect(modelAcceptsImageInput("openrouter", "openai/gpt-4o")).toBe(true);
    expect(modelAcceptsImageInput("openrouter", "deepseek/deepseek-v4-flash-vision-exp")).toBe(
      true,
    );
  });

  it("sees models the runtime adds to the bundled catalog", () => {
    expect(modelAcceptsImageInput("anthropic", "claude-sonnet-5-5")).toBe(true);
    expect(modelAcceptsImageInput("openai-codex", "gpt-6.1-sol")).toBe(true);
  });

  it("resolves the scripted placeholder like Pi before checking vision", () => {
    vi.stubEnv("PI_DEFAULT_MODEL", "");
    expect(resolveModelRefForVisionCheck("scripted", "scripted")).toEqual({
      provider: "openrouter",
      id: "openai/gpt-6-luna",
    });
    expect(modelAcceptsImageInput("scripted", "scripted")).toBe(true);

    vi.stubEnv("PI_DEFAULT_MODEL", "openai/gpt-4o");
    expect(resolveModelRefForVisionCheck("scripted", "scripted")).toEqual({
      provider: "openrouter",
      id: "openai/gpt-4o",
    });
    expect(modelAcceptsImageInput("scripted", "scripted")).toBe(true);
  });

  it("treats unknown models as text-only", () => {
    expect(modelAcceptsImageInput("openrouter", "rakazo-test/unknown-future-model")).toBe(false);
  });

  it("keeps explicit image capability scoped to the selected model", () => {
    const enabled = updateModelImageCapabilities(
      [" vision-model ", "text-model"],
      "text-model",
      false,
    );
    expect(enabled).toEqual(["vision-model"]);
    expect(modelIdSupportsImages(enabled, "vision-model")).toBe(true);
    expect(modelIdSupportsImages(enabled, "text-model")).toBe(false);
  });

  it("keeps computer action tools for a text-only model and drops only observation", () => {
    const names = filterImageReturningComputerTools(builtinAgentTools, {
      graphicalAllowed: true,
      acceptsImages: false,
    }).map((tool) => tool.name);
    // Acting does not need vision: the result carries a text description instead.
    expect(names).toContain("computer_act");
    expect(names).toContain("open_path");
    expect(names).toContain("launch_app");
    // Observation exists to show pixels, so it is withheld.
    expect(names).not.toContain("computer_observe");
    expect(names).toContain("shell");
    expect(names).toContain("list_files");
  });

  it("drops every screen tool when there is no graphical computer", () => {
    const names = filterImageReturningComputerTools(builtinAgentTools, {
      graphicalAllowed: false,
      acceptsImages: true,
    }).map((tool) => tool.name);
    for (const name of IMAGE_RETURNING_COMPUTER_TOOLS) {
      expect(names).not.toContain(name);
    }
    expect(names).toContain("shell");
    expect(names).toContain("list_files");
  });

  it("keeps image-returning computer tools for vision models", () => {
    const names = filterImageReturningComputerTools(builtinAgentTools, {
      graphicalAllowed: true,
      acceptsImages: true,
    }).map((tool) => tool.name);
    expect(names).toEqual(builtinAgentTools.map((tool) => tool.name));
    expect(names).toContain("computer_observe");
    expect(names).toContain("computer_act");
  });

  it("exposes a clear operator-facing cannot-see message", () => {
    expect(MODEL_CANNOT_SEE_MESSAGE).toMatch(/cannot see/i);
    expect(MODEL_CANNOT_SEE_MESSAGE).toMatch(/vision-capable model/i);
  });
});

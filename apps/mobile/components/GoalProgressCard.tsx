import type { Goal } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { AppState, Pressable, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { NativeActionButton } from "./native-action-button";

export function GoalProgressCard({ botId }: { botId: string }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [goal, setGoal] = useState<Goal>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let loading = false;
    const refresh = async () => {
      if (loading || AppState.currentState !== "active") return;
      loading = true;
      try {
        const rows = await rpc<Goal[]>("goals/list", { botId });
        if (!cancelled) {
          setGoal(
            rows.find((row) => ["active", "paused", "blocked"].includes(row.status)) ?? rows[0],
          );
          setError(false);
        }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    const listener = AppState.addEventListener("change", () => void refresh());
    return () => {
      cancelled = true;
      clearInterval(timer);
      listener.remove();
    };
  }, [botId]);
  if (!goal) return null;
  const control = async (action: "pause" | "resume" | "stop") => {
    setBusy(true);
    try {
      setGoal(
        await rpc<Goal>("goals/control", { goalId: goal.id, revision: goal.revision, action }),
      );
      setError(false);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View
      style={{
        borderColor: tokens.border,
        borderWidth: 1,
        borderRadius: 14,
        padding: 12,
        gap: 8,
        marginVertical: 8,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
      >
        <Text style={{ color: tokens.foreground, fontWeight: "600" }}>
          {goal.title} · {goal.steps.filter((step) => step.status === "done").length}/
          {goal.steps.length}
        </Text>
        <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>{t(goal.status)}</Text>
      </Pressable>
      {open ? (
        <>
          <Text style={{ color: tokens.mutedForeground }}>{goal.successCriteria}</Text>
          {goal.steps.map((step) => (
            <View key={step.id}>
              <Text style={{ color: tokens.foreground }}>
                {step.status === "done" ? "✓" : "○"} {step.title} · {t(step.status)}
              </Text>
              {step.evidence ? (
                <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>{step.evidence}</Text>
              ) : null}
            </View>
          ))}
          {goal.checkpoint ? (
            <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>{goal.checkpoint}</Text>
          ) : null}
          {!["completed", "stopped"].includes(goal.status) ? (
            <View style={{ flexDirection: "row", gap: 16 }}>
              <NativeActionButton
                prominence="plain"
                label={goal.status === "active" ? t("Pause goal") : t("Resume goal")}
                disabled={busy}
                onPress={() => void control(goal.status === "active" ? "pause" : "resume")}
              />
              <NativeActionButton
                prominence="plain"
                label={t("Stop goal")}
                disabled={busy}
                onPress={() => void control("stop")}
              />
            </View>
          ) : null}
        </>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {t("Could not refresh goal. Try again.")}
        </Text>
      ) : null}
    </View>
  );
}

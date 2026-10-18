import type { Goal } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { Alert, AppState, Pressable, Text, TextInput, View } from "react-native";
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
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftCriteria, setDraftCriteria] = useState("");
  const [draftSteps, setDraftSteps] = useState<Array<{ id: string; title: string }>>([]);
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
  const beginEdit = () => {
    setDraftTitle(goal.title);
    setDraftCriteria(goal.successCriteria);
    setDraftSteps(goal.steps.map((step) => ({ id: step.id, title: step.title })));
    setEditing(true);
  };
  const stepTitles = draftSteps
    .map((step) => ({ stepId: step.id, title: step.title.trim() }))
    .filter(
      (step) => step.title !== goal.steps.find((original) => original.id === step.stepId)?.title,
    );
  const editDirty =
    draftTitle.trim() !== goal.title ||
    draftCriteria.trim() !== goal.successCriteria ||
    stepTitles.length > 0;
  const editValid =
    Boolean(draftTitle.trim()) &&
    Boolean(draftCriteria.trim()) &&
    draftSteps.every((step) => Boolean(step.title.trim())) &&
    editDirty;
  const saveEdit = async () => {
    const title = draftTitle.trim();
    const successCriteria = draftCriteria.trim();
    if (!editValid) return;
    setBusy(true);
    setError(false);
    try {
      const updated = await rpc<Goal>("goals/update", {
        goalId: goal.id,
        revision: goal.revision,
        ...(title !== goal.title ? { title } : {}),
        ...(successCriteria !== goal.successCriteria ? { successCriteria } : {}),
        ...(stepTitles.length ? { stepTitles } : {}),
      });
      setGoal(updated);
      setEditing(false);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  const confirmDelete = () => {
    Alert.alert(t("Delete goal"), t("Delete this goal? This cannot be undone."), [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Delete"),
        style: "destructive",
        onPress: () => {
          void (async () => {
            setBusy(true);
            setError(false);
            try {
              await rpc<{ ok: true }>("goals/delete", { goalId: goal.id, revision: goal.revision });
              setEditing(false);
              setGoal(undefined);
            } catch {
              setError(true);
            } finally {
              setBusy(false);
            }
          })();
        },
      },
    ]);
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
          <View style={{ flexDirection: "row", gap: 16 }}>
            <NativeActionButton
              prominence="plain"
              label={t("Edit goal")}
              disabled={busy}
              onPress={beginEdit}
            />
            <NativeActionButton
              prominence="plain"
              label={t("Delete goal")}
              disabled={busy}
              onPress={confirmDelete}
            />
          </View>
          {editing ? (
            <View
              style={{
                gap: 10,
                padding: 12,
                borderWidth: 1,
                borderColor: tokens.border,
                borderRadius: 8,
              }}
            >
              <TextInput
                accessibilityLabel={t("Title")}
                value={draftTitle}
                maxLength={200}
                onChangeText={setDraftTitle}
                style={{
                  color: tokens.foreground,
                  borderColor: tokens.border,
                  borderWidth: 1,
                  borderRadius: 8,
                  padding: 8,
                }}
              />
              <TextInput
                accessibilityLabel={t("Success criteria")}
                value={draftCriteria}
                maxLength={2000}
                multiline
                onChangeText={setDraftCriteria}
                style={{
                  color: tokens.foreground,
                  borderColor: tokens.border,
                  borderWidth: 1,
                  borderRadius: 8,
                  padding: 8,
                  minHeight: 72,
                }}
              />
              {draftSteps.map((step, index) => (
                <TextInput
                  key={step.id}
                  accessibilityLabel={t("Step {number}", { number: index + 1 })}
                  value={step.title}
                  maxLength={200}
                  onChangeText={(title) =>
                    setDraftSteps((rows) =>
                      rows.map((row) => (row.id === step.id ? { ...row, title } : row)),
                    )
                  }
                  style={{
                    color: tokens.foreground,
                    borderColor: tokens.border,
                    borderWidth: 1,
                    borderRadius: 8,
                    padding: 8,
                  }}
                />
              ))}
              <View style={{ flexDirection: "row", gap: 16 }}>
                <NativeActionButton
                  prominence="plain"
                  label={t("Cancel")}
                  disabled={busy}
                  onPress={() => setEditing(false)}
                />
                <NativeActionButton
                  prominence="primary"
                  label={t("Save")}
                  disabled={busy || !editValid}
                  onPress={() => void saveEdit()}
                />
              </View>
            </View>
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

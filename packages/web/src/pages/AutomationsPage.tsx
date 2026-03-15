import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../components/PageHeader";
import {
  listScheduledTasks,
  createScheduledTask,
  updateScheduledTask,
  runScheduledTask,
  deleteScheduledTask,
  type ScheduledTaskInfo,
} from "../api/client";
import { IconEdit, IconPlay, IconTrash } from "../components/Icons";
import "./TasksPage.css";

type Frequency = "daily" | "weekdays" | "weekly" | "monthly" | "custom";

/** Build a cron expression from visual schedule picker state */
function buildCron(
  freq: Frequency,
  time: string,
  weekday: number,
  monthday: number,
  customCron: string,
): string {
  if (freq === "custom") return customCron;
  const [h, m] = time.split(":").map(Number);
  const mm = isNaN(m) ? 0 : m;
  const hh = isNaN(h) ? 9 : h;
  switch (freq) {
    case "daily":
      return `${mm} ${hh} * * *`;
    case "weekdays":
      return `${mm} ${hh} * * 1-5`;
    case "weekly":
      return `${mm} ${hh} * * ${weekday}`;
    case "monthly":
      return `${mm} ${hh} ${monthday} * *`;
    default:
      return `${mm} ${hh} * * *`;
  }
}

/** Parse a cron expression into visual picker state (best-effort) */
function parseCron(cron: string): {
  freq: Frequency;
  time: string;
  weekday: number;
  monthday: number;
} {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5)
    return { freq: "custom", time: "09:00", weekday: 1, monthday: 1 };
  const [mm, hh, dom, , dow] = parts;
  const time = `${hh.padStart(2, "0")}:${mm.padStart(2, "0")}`;
  if (dom === "*" && dow === "*")
    return { freq: "daily", time, weekday: 1, monthday: 1 };
  if (dom === "*" && dow === "1-5")
    return { freq: "weekdays", time, weekday: 1, monthday: 1 };
  if (dom === "*" && /^\d$/.test(dow))
    return { freq: "weekly", time, weekday: Number(dow), monthday: 1 };
  if (/^\d+$/.test(dom) && dow === "*")
    return { freq: "monthly", time, weekday: 1, monthday: Number(dom) };
  return { freq: "custom", time, weekday: 1, monthday: 1 };
}

/** Human-readable schedule description */
function describeCron(cron: string, t: (k: string) => string): string {
  const { freq, time } = parseCron(cron);
  const parts = cron.trim().split(/\s+/);
  const dayNames = [
    t("dayNames.sun"),
    t("dayNames.mon"),
    t("dayNames.tue"),
    t("dayNames.wed"),
    t("dayNames.thu"),
    t("dayNames.fri"),
    t("dayNames.sat"),
  ];
  switch (freq) {
    case "daily":
      return `${t("tasks.schedEveryDay")} ${time}`;
    case "weekdays":
      return `${t("tasks.schedWeekdays")} ${time}`;
    case "weekly":
      return `${t("tasks.schedEveryWeek")} ${dayNames[Number(parts[4])]} ${time}`;
    case "monthly":
      return `${t("tasks.schedEveryMonth")} ${parts[2]}${t("tasks.schedDaySuffix")} ${time}`;
    default:
      return cron;
  }
}

export function AutomationsPage() {
  const { t } = useTranslation();
  const [automations, setAutomations] = useState<ScheduledTaskInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmDelId, setConfirmDelId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Form state — shared for create & edit
  const [formMode, setFormMode] = useState<
    { type: "hidden" } | { type: "create" } | { type: "edit"; id: string }
  >({ type: "hidden" });
  const [name, setName] = useState("");
  const [action, setAction] = useState("");
  const [freq, setFreq] = useState<Frequency>("daily");
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState(1);
  const [monthday, setMonthday] = useState(1);
  const [customCron, setCustomCron] = useState("");

  const cronExpr = useMemo(
    () => buildCron(freq, time, weekday, monthday, customCron),
    [freq, time, weekday, monthday, customCron],
  );

  const fetchAuto = useCallback(async () => {
    try {
      const res = await listScheduledTasks();
      setAutomations(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAuto();
  }, [fetchAuto]);

  const resetForm = () => {
    setName("");
    setAction("");
    setFreq("daily");
    setTime("09:00");
    setWeekday(1);
    setMonthday(1);
    setCustomCron("");
    setFormMode({ type: "hidden" });
  };

  const openCreate = () => {
    resetForm();
    setFormMode({ type: "create" });
  };

  const openEdit = (auto: ScheduledTaskInfo) => {
    setName(auto.name);
    setAction(auto.action);
    const parsed = parseCron(auto.cron);
    setFreq(parsed.freq);
    setTime(parsed.time);
    setWeekday(parsed.weekday);
    setMonthday(parsed.monthday);
    if (parsed.freq === "custom") setCustomCron(auto.cron);
    else setCustomCron("");
    setFormMode({ type: "edit", id: auto.id });
  };

  const handleSave = async () => {
    if (!name.trim() || !cronExpr.trim() || !action.trim()) return;
    setSaving(true);
    try {
      if (formMode.type === "create") {
        const task = await createScheduledTask({
          name: name.trim(),
          cron: cronExpr.trim(),
          action: action.trim(),
          enabled: true,
        });
        setAutomations((prev) => [...prev, task]);
      } else if (formMode.type === "edit") {
        const updated = await updateScheduledTask(formMode.id, {
          name: name.trim(),
          cron: cronExpr.trim(),
          action: action.trim(),
        });
        setAutomations((prev) =>
          prev.map((a) => (a.id === formMode.id ? updated : a)),
        );
      }
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (auto: ScheduledTaskInfo) => {
    try {
      const updated = await updateScheduledTask(auto.id, {
        enabled: !auto.enabled,
      });
      setAutomations((prev) =>
        prev.map((a) => (a.id === auto.id ? updated : a)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    }
  };

  const [runningId, setRunningId] = useState<string | null>(null);

  const handleRunNow = async (auto: ScheduledTaskInfo) => {
    if (runningId) return; // prevent double-click
    setRunningId(auto.id);
    try {
      const updated = await runScheduledTask(auto.id);
      setAutomations((prev) =>
        prev.map((a) => (a.id === auto.id ? updated : a)),
      );
      // Keep spinning for a few seconds to indicate task is running in background
      await new Promise((r) => setTimeout(r, 3000));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run");
    } finally {
      setRunningId(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (confirmDelId !== id) {
      setConfirmDelId(id);
      return;
    }
    try {
      await deleteScheduledTask(id);
      setAutomations((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setConfirmDelId(null);
    }
  };

  const dayNames = [
    t("dayNames.sun"),
    t("dayNames.mon"),
    t("dayNames.tue"),
    t("dayNames.wed"),
    t("dayNames.thu"),
    t("dayNames.fri"),
    t("dayNames.sat"),
  ];

  const showForm = formMode.type !== "hidden";

  return (
    <>
      <PageHeader>{t("nav.automations")}</PageHeader>
      <div className="page-body">
        {loading ? (
          <div className="tasks-loading">{t("common.loading")}</div>
        ) : (
          <div className="tm-automations">
            {error && (
              <div className="tasks-error">
                {error}
                <button onClick={() => setError(null)}>
                  {t("common.dismiss")}
                </button>
              </div>
            )}

            {!showForm && (
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  marginBottom: 12,
                }}
              >
                <button
                  className="btn-secondary"
                  onClick={openCreate}
                  style={{ padding: "4px 12px", fontSize: 13 }}
                >
                  {t("tasks.addAutomation")}
                </button>
              </div>
            )}

            {showForm && (
              <div className="auto-form">
                <input
                  type="text"
                  className="tasks-form-input"
                  placeholder={t("tasks.namePlaceholder")}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />

                <textarea
                  className="tasks-form-input auto-action-textarea"
                  placeholder={t("tasks.actionPlaceholder")}
                  value={action}
                  onChange={(e) => setAction(e.target.value)}
                  rows={3}
                />

                <div className="auto-schedule-section">
                  <label className="auto-schedule-label">
                    {t("tasks.schedule")}
                  </label>
                  <div className="auto-schedule-row">
                    <select
                      className="auto-select"
                      value={freq}
                      onChange={(e) => setFreq(e.target.value as Frequency)}
                    >
                      <option value="daily">{t("tasks.freqDaily")}</option>
                      <option value="weekdays">
                        {t("tasks.freqWeekdays")}
                      </option>
                      <option value="weekly">{t("tasks.freqWeekly")}</option>
                      <option value="monthly">{t("tasks.freqMonthly")}</option>
                      <option value="custom">{t("tasks.freqCustom")}</option>
                    </select>

                    {freq === "weekly" && (
                      <select
                        className="auto-select"
                        value={weekday}
                        onChange={(e) => setWeekday(Number(e.target.value))}
                      >
                        {dayNames.map((d, i) => (
                          <option key={i} value={i}>
                            {d}
                          </option>
                        ))}
                      </select>
                    )}

                    {freq === "monthly" && (
                      <select
                        className="auto-select"
                        value={monthday}
                        onChange={(e) => setMonthday(Number(e.target.value))}
                      >
                        {Array.from({ length: 28 }, (_, i) => i + 1).map(
                          (d) => (
                            <option key={d} value={d}>
                              {d}
                              {t("tasks.schedDaySuffix")}
                            </option>
                          ),
                        )}
                      </select>
                    )}

                    {freq !== "custom" && (
                      <input
                        type="time"
                        className="auto-time-input"
                        value={time}
                        onChange={(e) => setTime(e.target.value)}
                      />
                    )}

                    {freq === "custom" && (
                      <input
                        type="text"
                        className="tasks-form-input auto-cron-input"
                        placeholder={t("tasks.cronPlaceholder")}
                        value={customCron}
                        onChange={(e) => setCustomCron(e.target.value)}
                      />
                    )}
                  </div>

                  {freq !== "custom" && (
                    <div className="auto-schedule-preview">
                      <code>{cronExpr}</code>
                    </div>
                  )}
                </div>

                <div className="tasks-form-actions">
                  <button
                    className="btn-primary"
                    onClick={handleSave}
                    disabled={
                      saving ||
                      !name.trim() ||
                      !cronExpr.trim() ||
                      !action.trim()
                    }
                  >
                    {saving ? t("common.saving") : t("common.save")}
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={resetForm}
                    disabled={saving}
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              </div>
            )}

            {automations.length === 0 && !showForm ? (
              <div className="tasks-empty">{t("tasks.noAutomations")}</div>
            ) : (
              <div className="auto-list">
                {automations.map((auto) => (
                  <div key={auto.id} className="auto-item">
                    <div className="auto-item-header">
                      <div className="auto-item-left">
                        <div
                          className={`auto-toggle ${auto.enabled ? "enabled" : ""}`}
                          title={
                            auto.enabled
                              ? t("tasks.enabled")
                              : t("tasks.disabled")
                          }
                          onClick={() => handleToggle(auto)}
                        >
                          <div className="auto-toggle-knob" />
                        </div>
                        <span className="auto-name">{auto.name}</span>
                      </div>
                      <div className="auto-item-actions">
                        {confirmDelId === auto.id ? (
                          <span className="auto-confirm-delete">
                            <span className="auto-confirm-text">
                              {t("tasks.deleteConfirm")}
                            </span>
                            <button
                              className="btn-danger tasks-card-btn"
                              onClick={() => handleDelete(auto.id)}
                            >
                              {t("common.yes")}
                            </button>
                            <button
                              className="btn-secondary tasks-card-btn"
                              onClick={() => setConfirmDelId(null)}
                            >
                              {t("common.no")}
                            </button>
                          </span>
                        ) : (
                          <>
                            <button
                              className="btn-icon"
                              onClick={() => openEdit(auto)}
                              title={t("common.edit")}
                            >
                              <IconEdit size={15} />
                            </button>
                            <button
                              className={`btn-icon auto-icon-btn-play${runningId === auto.id ? " auto-running" : ""}`}
                              onClick={() => handleRunNow(auto)}
                              disabled={!!runningId}
                              title={t("tasks.runNow")}
                            >
                              <IconPlay size={15} />
                            </button>
                            <button
                              className="btn-icon auto-icon-btn-danger"
                              onClick={() => handleDelete(auto.id)}
                              title={t("common.delete")}
                            >
                              <IconTrash size={15} />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="auto-item-details">
                      <span>
                        <span className="auto-detail-label">
                          {t("tasks.schedule")}
                        </span>{" "}
                        {describeCron(auto.cron, t)}
                      </span>
                      <span>
                        <span className="auto-detail-label">
                          {t("tasks.action")}
                        </span>{" "}
                        {auto.action}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

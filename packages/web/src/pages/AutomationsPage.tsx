import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../components/PageHeader";
import {
  listScheduledTasks,
  createScheduledTask,
  deleteScheduledTask,
  type ScheduledTaskInfo,
} from "../api/client";
import "./TasksPage.css";

export function AutomationsPage() {
  const { t } = useTranslation();
  const [automations, setAutomations] = useState<ScheduledTaskInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [cron, setCron] = useState("");
  const [action, setAction] = useState("");
  const [confirmDelId, setConfirmDelId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const handleCreate = async () => {
    if (!name.trim() || !cron.trim() || !action.trim()) return;
    setSaving(true);
    try {
      const task = await createScheduledTask({
        name: name.trim(),
        cron: cron.trim(),
        action: action.trim(),
        enabled: true,
      });
      setAutomations((prev) => [...prev, task]);
      setShowForm(false);
      setName("");
      setCron("");
      setAction("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (confirmDelId !== id) {
      setConfirmDelId(id);
      return;
    }
    try {
      await deleteScheduledTask(id);
      setAutomations((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setConfirmDelId(null);
    }
  };

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
                  onClick={() => setShowForm(true)}
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
                <input
                  type="text"
                  className="tasks-form-input"
                  placeholder={t("tasks.cronPlaceholder")}
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
                />
                <input
                  type="text"
                  className="tasks-form-input"
                  placeholder={t("tasks.actionPlaceholder")}
                  value={action}
                  onChange={(e) => setAction(e.target.value)}
                />
                <div className="tasks-form-actions">
                  <button
                    className="btn-primary"
                    onClick={handleCreate}
                    disabled={
                      saving || !name.trim() || !cron.trim() || !action.trim()
                    }
                  >
                    {saving ? t("common.saving") : t("common.save")}
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={() => setShowForm(false)}
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
                          <button
                            className="btn-secondary tasks-card-btn"
                            onClick={() => handleDelete(auto.id)}
                          >
                            {t("common.delete")}
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="auto-item-details">
                      <span>
                        <span className="auto-detail-label">
                          {t("tasks.cron")}
                        </span>{" "}
                        <code>{auto.cron}</code>
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

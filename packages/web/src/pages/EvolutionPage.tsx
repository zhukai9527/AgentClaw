import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import {
  listEvolutionEvents,
  listEvolutionRuns,
  type EvolutionEventInfo,
  type EvolutionRunInfo,
  type EvolutionRunStatus,
  type EvolutionTargetType,
} from "../api/client";
import { formatDateTime } from "../utils/format";
import "./EvolutionPage.css";

export type { EvolutionRunInfo };

const RUN_LIMIT = 100;

const TARGET_TYPES: EvolutionTargetType[] = [
  "skill",
  "tool",
  "prompt",
  "memory_policy",
  "eval",
  "agent",
  "other",
];

const STATUSES: EvolutionRunStatus[] = [
  "proposed",
  "baseline",
  "applied",
  "verified",
  "failed",
  "rolled_back",
];

export function summarizeEvolutionRuns(runs: readonly EvolutionRunInfo[]) {
  return {
    total: runs.length,
    improved: runs.filter((run) => run.result === "improved").length,
    regressed: runs.filter((run) => run.result === "regressed").length,
    verified: runs.filter((run) => run.status === "verified").length,
    regressions: runs.reduce((sum, run) => sum + run.regressionCount, 0),
  };
}

function shortId(id?: string): string {
  if (!id) return "-";
  return id.length > 14 ? `${id.slice(0, 8)}...${id.slice(-4)}` : id;
}

function formatScore(value?: number): string {
  return value === undefined ? "-" : String(value);
}

function JsonBlock({ value }: { value?: Record<string, unknown> }) {
  if (!value || Object.keys(value).length === 0) return null;
  return <pre className="evolution-json">{JSON.stringify(value, null, 2)}</pre>;
}

function RunBadge({
  value,
  kind,
}: {
  value: string;
  kind: "status" | "result";
}) {
  return (
    <span className={`evolution-badge ${kind}-${value}`}>{value}</span>
  );
}

function EvolutionEventRow({ event }: { event: EvolutionEventInfo }) {
  return (
    <div className="evolution-event">
      <span
        className={`evolution-event-dot${event.success ? "" : " is-error"}`}
      />
      <div className="evolution-event-body">
        <div className="evolution-event-main">
          <span className="evolution-event-type">{event.eventType}</span>
          <span className="evolution-event-time">
            {formatDateTime(event.createdAt)}
          </span>
        </div>
        {event.message && (
          <div className="evolution-event-message">{event.message}</div>
        )}
        <div className="evolution-event-meta">
          <span>trace {shortId(event.traceId)}</span>
          {event.changeId && <span>change {shortId(event.changeId)}</span>}
          <span>
            score {formatScore(event.scoreBefore)} {"->"}{" "}
            {formatScore(event.scoreAfter)}
          </span>
        </div>
        <JsonBlock value={event.data} />
      </div>
    </div>
  );
}

export function EvolutionPage() {
  const [runs, setRuns] = useState<EvolutionRunInfo[]>([]);
  const [events, setEvents] = useState<EvolutionEventInfo[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [targetType, setTargetType] = useState<EvolutionTargetType | "">("");
  const [status, setStatus] = useState<EvolutionRunStatus | "">("");
  const [targetId, setTargetId] = useState("");
  const [loading, setLoading] = useState(true);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const summary = useMemo(() => summarizeEvolutionRuns(runs), [runs]);
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null;

  const fetchRuns = useCallback(async () => {
    try {
      setLoading(true);
      const data = await listEvolutionRuns({
        targetType: targetType || undefined,
        targetId: targetId.trim() || undefined,
        status: status || undefined,
        limit: RUN_LIMIT,
      });
      setRuns(data);
      setSelectedRunId((current) => current ?? data[0]?.id ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载进化日志失败");
    } finally {
      setLoading(false);
    }
  }, [status, targetId, targetType]);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  useEffect(() => {
    if (!selectedRunId) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    setEventsLoading(true);
    listEvolutionEvents({ runId: selectedRunId, limit: 100 })
      .then((data) => {
        if (!cancelled) setEvents(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "加载事件失败");
        }
      })
      .finally(() => {
        if (!cancelled) setEventsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  return (
    <>
      <PageHeader>进化日志</PageHeader>
      <div className="page-body evolution-page">
        {error && (
          <div className="evolution-error">
            {error}
            <button onClick={() => setError(null)}>关闭</button>
          </div>
        )}

        <section className="evolution-summary">
          <div>
            <span className="evolution-summary-label">总运行</span>
            <strong>{summary.total}</strong>
          </div>
          <div>
            <span className="evolution-summary-label">已验证</span>
            <strong>{summary.verified}</strong>
          </div>
          <div>
            <span className="evolution-summary-label">变强</span>
            <strong>{summary.improved}</strong>
          </div>
          <div className={summary.regressions > 0 ? "has-regression" : ""}>
            <span className="evolution-summary-label">回退数</span>
            <strong>{summary.regressions}</strong>
          </div>
        </section>

        <div className="evolution-toolbar">
          <select
            value={targetType}
            onChange={(event) =>
              setTargetType(event.target.value as EvolutionTargetType | "")
            }
          >
            <option value="">全部目标</option>
            {TARGET_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <select
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as EvolutionRunStatus | "")
            }
          >
            <option value="">全部状态</option>
            {STATUSES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <input
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
            placeholder="targetId"
          />
          <button onClick={fetchRuns} disabled={loading}>
            {loading ? "刷新中" : "刷新"}
          </button>
        </div>

        <div className="evolution-layout">
          <div className="evolution-run-list">
            {loading ? (
              <div className="evolution-empty">加载进化日志中...</div>
            ) : runs.length === 0 ? (
              <div className="evolution-empty">暂无进化记录</div>
            ) : (
              runs.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  className={`evolution-run-card${
                    run.id === selectedRunId ? " active" : ""
                  }`}
                  onClick={() => setSelectedRunId(run.id)}
                >
                  <div className="evolution-run-head">
                    <span className="evolution-target">
                      {run.targetType}/{run.targetId}
                    </span>
                    <span className="evolution-run-time">
                      {formatDateTime(run.updatedAt)}
                    </span>
                  </div>
                  <div className="evolution-run-badges">
                    <RunBadge kind="status" value={run.status} />
                    <RunBadge kind="result" value={run.result} />
                  </div>
                  <div className="evolution-run-score">
                    score {formatScore(run.baselineScore)} {"->"}{" "}
                    {formatScore(run.afterScore)}
                    <span> regressions {run.regressionCount}</span>
                  </div>
                </button>
              ))
            )}
          </div>

          <section className="evolution-detail">
            {!selectedRun ? (
              <div className="evolution-empty">选择一条进化记录查看事件</div>
            ) : (
              <>
                <div className="evolution-detail-head">
                  <div>
                    <h2>{selectedRun.targetId}</h2>
                    <p>{selectedRun.reason || "无记录原因"}</p>
                  </div>
                  <div className="evolution-run-badges">
                    <RunBadge kind="status" value={selectedRun.status} />
                    <RunBadge kind="result" value={selectedRun.result} />
                  </div>
                </div>

                <dl className="evolution-detail-grid">
                  <div>
                    <dt>runId</dt>
                    <dd>{selectedRun.id}</dd>
                  </div>
                  <div>
                    <dt>traceId</dt>
                    <dd>{selectedRun.triggerTraceId ?? "-"}</dd>
                  </div>
                  <div>
                    <dt>conversationId</dt>
                    <dd>{selectedRun.triggerConversationId ?? "-"}</dd>
                  </div>
                  <div>
                    <dt>evalReport</dt>
                    <dd>{selectedRun.evalReportPath ?? "-"}</dd>
                  </div>
                </dl>

                <div className="evolution-events">
                  <h3>事件时间线</h3>
                  {eventsLoading ? (
                    <div className="evolution-empty">加载事件中...</div>
                  ) : events.length === 0 ? (
                    <div className="evolution-empty">暂无事件</div>
                  ) : (
                    events.map((event) => (
                      <EvolutionEventRow key={event.id} event={event} />
                    ))
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

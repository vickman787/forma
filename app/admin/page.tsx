"use client";
import { useEffect, useState } from "react";
import { api, Workspace, ErrorMessage, useSession } from "@/components/studio";
export default function Page() {
  const { session } = useSession(),
    [data, setData] = useState<any>(null),
    [plan, setPlan] = useState<any>(null),
    [planning, setPlanning] = useState(false),
    [error, setError] = useState("");
  async function prepare(id: string, action: string) {
    setError("");
    setPlan(null);
    setPlanning(true);
    try {
      setPlan(await api(`admin/operator/${id}/plan?action=${action}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Plan unavailable");
    } finally {
      setPlanning(false);
    }
  }
  useEffect(() => {
    if (!session.authenticated || !session.admin) {
      setData(null);
      return;
    }
    let active = true;
    const refresh = () =>
      void api("admin/jobs")
        .then((result) => {
          if (active) {
            setData(result);
            setError("");
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    refresh();
    const timer = setInterval(refresh, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [session.authenticated, session.admin]);
  async function resolveIssue(id: string) {
    setPlanning(true);
    setError("");
    try {
      await api(`admin/issues/${id}/resolve`, {});
      setData(await api("admin/jobs"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update issue");
    } finally {
      setPlanning(false);
    }
  }
  return (
    <Workspace title="Owner dashboard">
      <div className="page-title">
        <div>
          <span className="eyebrow">Operations</span>
          <h1>A clear view of your studio.</h1>
          <p>Saved jobs, unresolved issues, usage, and escrow liabilities.</p>
        </div>
      </div>
      <ErrorMessage error={error} />
      {data ? (
        <>
          <section className="panel">
            <h2>Automatic services</h2>
            {data.workers?.length ? (
              data.workers.map((worker: any) => (
                <p key={worker.role}>
                  <strong>{worker.role}</strong> · {worker.state} · last seen{" "}
                  {new Date(worker.updated_at).toLocaleString()}
                </p>
              ))
            ) : (
              <p>No worker heartbeat has been recorded.</p>
            )}
            {data.operatorTasks
              ?.filter((task: any) =>
                ["blocked", "expired"].includes(task.status),
              )
              .map((task: any) => (
                <p className="field-error" key={task.id}>
                  {task.action} · {task.order_id}: {task.error}
                </p>
              ))}
          </section>
          <div className="admin-cards">
            {data.liabilities.map((l: any) => (
              <div className="panel" key={l.payment}>
                <h3>{l.payment}</h3>
                <p>
                  {l.count} orders · {Number(l.count)} QUSDC{" "}
                  {l.payment === "funded" ? "liability" : ""}
                </p>
              </div>
            ))}
          </div>
          <div className="panel">
            <h2>Escrow operations</h2>
            <p>
              Prepare a transaction for review. These controls do not sign or
              send transactions.
            </p>
            {!data.operations?.length ? (
              <p>No unsettled projects.</p>
            ) : (
              data.operations.map((o: any) => (
                <div className="admin-job" key={o.id}>
                  <strong>{o.id}</strong>
                  <p>
                    {o.mode} · {o.work} · {o.payment}
                  </p>
                  {o.mode === "live" ? (
                    <div className="actions">
                      {o.payment === "unfunded" &&
                      o.work === "awaiting_funding" ? (
                        <button
                          type="button"
                          disabled={planning}
                          onClick={() => void prepare(o.id, "create")}
                        >
                          Prepare registration
                        </button>
                      ) : null}
                      {o.payment === "funded" && o.work === "checking" ? (
                        <button
                          type="button"
                          disabled={planning}
                          onClick={() => void prepare(o.id, "deliver")}
                        >
                          Prepare delivery commitment
                        </button>
                      ) : null}
                      {o.payment === "funded" ? (
                        <button
                          type="button"
                          disabled={planning}
                          onClick={() => void prepare(o.id, "refund")}
                        >
                          Prepare refund
                        </button>
                      ) : null}
                      {o.payment === "funded" &&
                      o.work === "delivered" &&
                      o.review_due &&
                      Date.parse(o.review_due) <= Date.now() ? (
                        <button
                          type="button"
                          disabled={planning}
                          onClick={() => void prepare(o.id, "release")}
                        >
                          Prepare review release
                        </button>
                      ) : null}
                    </div>
                  ) : (
                    <p>
                      This historical order cannot be operated from this
                      workspace.
                    </p>
                  )}
                </div>
              ))
            )}
            {plan ? (
              <div role="status">
                <h3>Unsigned transaction — approval required</h3>
                <p>
                  Review the wallet, contract, action and amount before signing
                  externally.
                </p>
                <pre
                  style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                >
                  {JSON.stringify(plan, null, 2)}
                </pre>
              </div>
            ) : null}
          </div>
          <div className="panel">
            <h2>Jobs</h2>
            {data.jobs.map((j: any) => (
              <div className="admin-job" key={j.id}>
                <strong>
                  {j.order_id} · {j.mode}
                </strong>
                <p>
                  {j.status} / {j.stage} · attempts {j.attempts}
                </p>
                {j.error ? <p className="field-error">{j.error}</p> : null}
                <pre>{j.usage || "No paid provider usage recorded."}</pre>
              </div>
            ))}
          </div>
          <div className="panel">
            <h2>Open support issues</h2>
            {data.issues.map((i: any) => (
              <div className="admin-job" key={i.id}>
                <p>
                  {i.order_id}: {i.description}
                </p>
                <button
                  className="button light"
                  disabled={planning}
                  onClick={() => void resolveIssue(i.id)}
                >
                  Mark resolved
                </button>
                <p className="fine">
                  Closes this support report only. It does not refund payment or
                  change the review deadline.
                </p>
              </div>
            ))}
            {!data.issues.length ? <p>No open problem reports.</p> : null}
          </div>
        </>
      ) : (
        <p>
          Sign in with an explicitly configured owner wallet. Access is enforced
          by the server.
        </p>
      )}
    </Workspace>
  );
}

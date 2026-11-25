"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  Clock,
  FileText,
  FolderOpen,
  RefreshCw,
  ShieldCheck,
  AlertCircle,
  Download,
  ExternalLink,
  MessageCircle,
  LoaderCircle,
} from "lucide-react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
  type Hex,
  parseAbi,
} from "viem";
import {
  api,
  useSession,
  Workspace,
  Steps,
  Scope,
  ErrorMessage,
  ServiceIcon,
  trapModalFocus,
} from "./studio";
import { getService, terms, type Order } from "@/lib/domain";
import { qieChain } from "@/lib/chain";
import { customerStatusText } from "@/lib/text";
const date = (value: string | null) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "After confirmed payment";
export function ProjectList() {
  const { session, connect } = useSession(),
    [orders, setOrders] = useState<Order[] | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    if (session.authenticated)
      void api<Order[]>("orders")
        .then(setOrders)
        .catch((e) => setError(e.message));
  }, [session.authenticated]);
  return (
    <Workspace title="My projects">
      <div className="page-title" id="main-content">
        <div>
          <span className="eyebrow">A home for your progress</span>
          <h1>Your ideas, taking shape.</h1>
          <p>Every brief, every file, every little step forward.</p>
        </div>
        <Link href="/new" className="button">
          New project
        </Link>
      </div>
      <ErrorMessage error={error} />
      {!session.authenticated ? (
        <Empty
          title="Your studio is waiting."
          body="Sign in to see the projects that belong to you."
          action={
            <button className="button" onClick={connect}>
              Open my workspace
            </button>
          }
        />
      ) : orders === null ? (
        <p className="loading">Loading your projects…</p>
      ) : orders.length === 0 ? (
        <Empty
          title="Your first good thing starts here."
          body="Give us a little about your business. We’ll help make it tangible."
          action={
            <Link href="/new" className="button">
              Create your first project
            </Link>
          }
        />
      ) : (
        <div className="project-list">
          {orders.map((o) => (
            <Link
              className="project-row panel"
              key={o.id}
              href={`/projects/${o.id}${o.work === "awaiting_funding" ? "/review" : ""}`}
            >
              <span
                className={`project-service-icon ${getService(o.brief.service).tone}`}
              >
                <ServiceIcon id={o.brief.service} />
              </span>
              <div>
                <h3>{o.brief.businessName}</h3>
                <p>
                  {getService(o.brief.service).name} <span>·</span>{" "}
                  {date(o.created_at)}
                </p>
              </div>
              <span className={"status " + o.work}>
                {o.work.replaceAll("_", " ")}
              </span>
              <span className="project-price">
                1 QUSDC
                <small>QIE Mainnet</small>
              </span>
            </Link>
          ))}
        </div>
      )}
    </Workspace>
  );
}
function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action: React.ReactNode;
}) {
  return (
    <div className="empty-state panel">
      <div className="round-icon">
        <FolderOpen size={30} />
      </div>
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </div>
  );
}
export function Project({
  id,
  view = "workspace",
}: {
  id: string;
  view?: "review" | "checkout" | "workspace";
}) {
  const { session, connect } = useSession(),
    router = useRouter(),
    [order, setOrder] = useState<Order | null>(null),
    [events, setEvents] = useState<any[]>([]),
    [artifacts, setArtifacts] = useState<any[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [problem, setProblem] = useState(false),
    [issue, setIssue] = useState(""),
    [issueSaved, setIssueSaved] = useState(false),
    [accept, setAccept] = useState(false),
    [policy, setPolicy] = useState(false),
    [paymentInfo, setPaymentInfo] = useState<any>(null),
    [tx, setTx] = useState(""),
    [paymentStep, setPaymentStep] = useState("");
  const refresh = async () => {
    const [o, ev, files] = await Promise.all([
      api<Order>("orders/" + id),
      api<any[]>("orders/" + id + "/events"),
      api<any[]>("orders/" + id + "/artifacts"),
    ]);
    setOrder(o);
    setEvents(ev);
    setArtifacts(files);
  };
  useEffect(() => {
    if (!session.authenticated) return;
    if (order?.id === id && order.work === "closed") return;
    let active = true;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const [o, ev, files] = await Promise.all([
          api<Order>("orders/" + id),
          api<any[]>("orders/" + id + "/events"),
          api<any[]>("orders/" + id + "/artifacts"),
        ]);
        if (active) {
          setOrder(o);
          if (["pending", "unknown"].includes(o.payment) && o.tx_hash)
            setTx(o.tx_hash);
          setEvents(ev);
          setArtifacts(files);
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [id, session.authenticated, order?.work]);
  useEffect(() => {
    if (view !== "checkout" || !session.authenticated) return;
    let active = true,
      running = false;
    const check = async () => {
      if (running) return;
      running = true;
      try {
        const info = await api("orders/" + id + "/payment-info");
        if (active) setPaymentInfo(info);
      } catch (e) {
        if (active)
          setError(
            e instanceof Error ? e.message : "Payment check unavailable",
          );
      } finally {
        running = false;
      }
    };
    void check();
    const timer = setInterval(() => void check(), 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [view, id, session.authenticated]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function pay() {
    if (!order) return;
    const pendingKey = "forma-pending-payment-" + id;
    const previous =
      localStorage.getItem(pendingKey) ||
      (["pending", "unknown"].includes(order.payment) ? order.tx_hash : null);
    if (previous) {
      setTx(previous);
      setPaymentStep("Checking the saved funding transaction…");
      await api("orders/" + id + "/payment-sync", { txHash: previous });
      localStorage.removeItem(pendingKey);
      router.push("/projects/" + id);
      return;
    }
    if (!window.ethereum) throw new Error("Connect a wallet extension first.");
    const info = await api("orders/" + id + "/payment-info");
    if (!info.enabled) throw new Error(info.reason);
    const ethereum = window.ethereum;
    const accounts = await ethereum.request({ method: "eth_requestAccounts" });
    if (accounts[0].toLowerCase() !== session.wallet?.toLowerCase())
      throw new Error(
        "Your connected wallet differs from the signed-in payer.",
      );
    const chain = await ethereum.request({ method: "eth_chainId" });
    if (chain !== "0x7c6")
      throw new Error(
        "Switch your wallet to QIE Mainnet (chain 1990), then retry.",
      );
    const wallet = createWalletClient({ transport: custom(ethereum) }),
      publicClient = createPublicClient({
        transport: http("https://rpc1mainnet.qie.digital"),
      }),
      address = accounts[0] as Address,
      token = info.token as Address,
      escrow = info.escrow as Address;
    const tokenABI = parseAbi([
      "function balanceOf(address) view returns(uint256)",
      "function allowance(address,address) view returns(uint256)",
      "function approve(address,uint256) returns(bool)",
    ]);
    const [balance, gas, allowance] = await Promise.all([
      publicClient.readContract({
        address: token,
        abi: tokenABI,
        functionName: "balanceOf",
        args: [address],
      }),
      publicClient.getBalance({ address }),
      publicClient.readContract({
        address: token,
        abi: tokenABI,
        functionName: "allowance",
        args: [address, escrow],
      }),
    ]);
    if (balance < 1000000n)
      throw new Error("Your wallet needs at least 1 QUSDC.");
    if (gas === 0n)
      throw new Error("Your wallet needs QIE to pay network fees.");
    let approved = allowance >= 1000000n;
    const approvalKey = "forma-pending-approval-" + id,
      savedApproval = localStorage.getItem(approvalKey);
    if (savedApproval) {
      setPaymentStep("Checking the saved approval transaction…");
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: savedApproval as Hex,
      });
      if (receipt.status !== "success") {
        localStorage.removeItem(approvalKey);
        throw new Error("Saved approval reverted. You may try again.");
      }
      localStorage.removeItem(approvalKey);
      approved =
        (await publicClient.readContract({
          address: token,
          abi: tokenABI,
          functionName: "allowance",
          args: [address, escrow],
        })) >= 1000000n;
    }
    if (!approved) {
      setPaymentStep("Approve exactly 1 QUSDC in your wallet.");
      const approval = await wallet.writeContract({
        account: address,
        chain: qieChain,
        address: token,
        abi: tokenABI,
        functionName: "approve",
        args: [escrow, 1000000n],
      });
      localStorage.setItem(approvalKey, approval);
      setPaymentStep("Waiting for token approval…");
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: approval,
      });
      localStorage.removeItem(approvalKey);
      if (receipt.status !== "success")
        throw new Error("Approval was not confirmed.");
    }
    const abi = parseAbi(["function fundJob(bytes32)"]);
    const gasEstimate = await publicClient.estimateContractGas({
      account: address,
      address: escrow,
      abi,
      functionName: "fundJob",
      args: [order.chain_job as Hex],
    });
    const gasPrice = await publicClient.getGasPrice();
    if (
      (await publicClient.getBalance({ address })) <
      (gasEstimate * gasPrice * 12n) / 10n
    )
      throw new Error("Not enough QIE for the estimated funding fee.");
    setPaymentStep(
      `Estimated funding gas: ${(Number(gasEstimate * gasPrice) / 1e18).toFixed(6)} QIE. Confirm funding in your wallet.`,
    );
    const hash = await wallet.writeContract({
      account: address,
      chain: qieChain,
      address: escrow,
      abi,
      functionName: "fundJob",
      args: [order.chain_job as Hex],
    });
    localStorage.setItem(pendingKey, hash);
    setTx(hash);
    setPaymentStep("Funding submitted. Awaiting three confirmations.");
    await api("orders/" + id + "/payment-record", { txHash: hash });
    await publicClient.waitForTransactionReceipt({ hash, confirmations: 3 });
    await api("orders/" + id + "/payment-sync", { txHash: hash });
    localStorage.removeItem(pendingKey);
    router.push("/projects/" + id);
  }
  async function acceptDelivery() {
    if (!window.ethereum || !order)
      throw new Error("Connect your payer wallet.");
    const [address] = await window.ethereum.request({
      method: "eth_requestAccounts",
    });
    if (address.toLowerCase() !== session.wallet?.toLowerCase())
      throw new Error("Switch to the signed-in payer wallet.");
    if ((await window.ethereum.request({ method: "eth_chainId" })) !== "0x7c6")
      throw new Error("Switch to QIE Mainnet.");
    const info = await api("orders/" + id + "/payment-info");
    const wallet = createWalletClient({ transport: custom(window.ethereum) }),
      rpc = createPublicClient({
        transport: http("https://rpc1mainnet.qie.digital"),
      });
    const saved = localStorage.getItem("forma-pending-accept-" + id);
    const hash =
      (saved as Hex) ||
      (await wallet.writeContract({
        account: address,
        chain: qieChain,
        address: info.escrow,
        abi: parseAbi(["function acceptDelivery(bytes32)"]),
        functionName: "acceptDelivery",
        args: [order.chain_job as Hex],
      }));
    localStorage.setItem("forma-pending-accept-" + id, hash);
    await rpc.waitForTransactionReceipt({ hash, confirmations: 3 });
    await api("orders/" + id + "/decision-sync", { txHash: hash });
    localStorage.removeItem("forma-pending-accept-" + id);
    setAccept(false);
  }
  async function claimLateRefund() {
    if (!order || order.mode !== "live" || !window.ethereum)
      throw new Error("Connect the payer wallet for this live order.");
    const [address] = await window.ethereum.request({
      method: "eth_requestAccounts",
    });
    if (address.toLowerCase() !== session.wallet?.toLowerCase())
      throw new Error("Switch to the signed-in payer wallet.");
    if ((await window.ethereum.request({ method: "eth_chainId" })) !== "0x7c6")
      throw new Error("Switch to QIE Mainnet.");
    const info = await api("orders/" + id + "/payment-info");
    if (!info.enabled) throw new Error(info.reason);
    const wallet = createWalletClient({ transport: custom(window.ethereum) }),
      rpc = createPublicClient({
        transport: http("https://rpc1mainnet.qie.digital"),
      }),
      key = "forma-pending-refund-" + id;
    const saved = localStorage.getItem(key);
    const hash =
      (saved as Hex) ||
      (await wallet.writeContract({
        account: address,
        chain: qieChain,
        address: info.escrow,
        abi: parseAbi(["function claimLateRefund(bytes32)"]),
        functionName: "claimLateRefund",
        args: [order.chain_job as Hex],
      }));
    localStorage.setItem(key, hash);
    await rpc.waitForTransactionReceipt({ hash, confirmations: 3 });
    await api("orders/" + id + "/decision-sync", { txHash: hash });
    localStorage.removeItem(key);
  }
  if (!session.authenticated)
    return (
      <Workspace title="Project">
        <Empty
          title="This project belongs in your workspace."
          body="Sign in with the account that created it to continue."
          action={
            <button className="button" onClick={connect}>
              Sign in
            </button>
          }
        />
      </Workspace>
    );
  if (!order)
    return (
      <Workspace title="Project">
        <ErrorMessage error={error} />
        {!error ? <p className="loading">Opening your project…</p> : null}
      </Workspace>
    );
  const service = getService(order.brief.service),
    isReview = view === "review" || view === "checkout",
    delivered =
      order.work === "delivered" ||
      (order.work === "closed" && !!order.manifest),
    reviewable =
      delivered ||
      (order.work === "checking" &&
        order.payment === "funded" &&
        !!order.manifest_hash),
    preview =
      artifacts.find((a) => a.mime.startsWith("text/html")) ||
      artifacts.find((a) => a.name === "promotional-flyer.png"),
    video = artifacts.find((a) => a.name === "promo-vertical.mp4"),
    poster = artifacts.find((a) => a.name === "poster.png");
  return (
    <Workspace title={isReview ? "Review project" : order.brief.businessName}>
      <div className="page-title" id="main-content">
        <div>
          <span className="eyebrow">
            {isReview
              ? "A clear starting point"
              : `Project F-${id.slice(0, 6).toUpperCase()} · Version ${order.version}`}
          </span>
          <h1>
            {view === "review"
              ? "A quick check before we begin."
              : view === "checkout"
                ? "Ready when you are."
                : order.payment === "refunded"
                  ? "Your payment was refunded."
                  : order.work === "closed"
                    ? "A good idea, brought to life."
                    : delivered
                      ? "Made for your next big moment."
                      : order.work === "failed"
                        ? "This step needs a little attention."
                        : "Your idea is taking shape."}
          </h1>
          <p>
            {service.name} <span>·</span> {order.brief.businessName}
          </p>
        </div>
        <span className={"status " + order.work}>
          {order.work.replaceAll("_", " ")}
        </span>
      </div>
      <div className="status-banner">
        <ShieldCheck size={18} />
        <span>QIE Mainnet · QUSDC · Network fees paid separately in QIE.</span>
      </div>
      <ErrorMessage error={error} />
      <div className="two-column">
        <div>
          {isReview ? (
            <>
              <section className="panel">
                <Steps step={view === "review" ? 2 : 3} />
                <div className="row">
                  <h2>Your project brief</h2>
                  <Link
                    className="text-link"
                    href={"/new?service=" + order.brief.service + "&edit=" + id}
                  >
                    Edit brief
                  </Link>
                </div>
                <dl className="brief-summary">
                  <dt>Service</dt>
                  <dd>{service.name}</dd>
                  <dt>Business</dt>
                  <dd>
                    {order.brief.businessName} · {order.brief.industry} ·{" "}
                    {order.brief.location}
                  </dd>
                  <dt>What we’re making</dt>
                  <dd>{order.brief.description}</dd>
                  <dt>Audience</dt>
                  <dd>{order.brief.audience}</dd>
                  <dt>Call to action</dt>
                  <dd>{order.brief.cta}</dd>
                  {order.brief.offer ? (
                    <>
                      <dt>Approved offer</dt>
                      <dd>{order.brief.offer}</dd>
                    </>
                  ) : null}
                  {order.brief.contact ? (
                    <>
                      <dt>Approved contact</dt>
                      <dd>{order.brief.contact}</dd>
                    </>
                  ) : null}
                  {order.brief.question ? (
                    <>
                      <dt>Research question</dt>
                      <dd>{order.brief.question}</dd>
                    </>
                  ) : null}
                  {order.brief.items.length ? (
                    <>
                      <dt>Exact prices</dt>
                      <dd>
                        {order.brief.items.map((item, i) => (
                          <div key={i}>
                            {item.name}: {item.currency} {item.price}
                          </div>
                        ))}
                      </dd>
                    </>
                  ) : null}
                </dl>
                <div className="rule" />
                <h3>Included in your delivery</h3>
                <ul className="checklist">
                  {service.outputs.map((v) => (
                    <li key={v}>
                      <Check size={16} />
                      {v}
                    </li>
                  ))}
                </ul>
                <div className="notice">
                  No unlisted exports, revisions, voiceover, custom domains, or
                  store checkout are included. You can report a problem before
                  settlement.
                </div>
              </section>
              <section className="panel terms-panel">
                <h2>Clear terms. No surprises.</h2>
                <p>{terms.text}</p>
                <dl className="brief-summary compact">
                  <dt>Fund by</dt>
                  <dd>
                    {date(order.funding_expires)}
                    <small>{order.funding_expires} UTC</small>
                  </dd>
                  <dt>Delivery window</dt>
                  <dd>24 hours after verified funding</dd>
                  <dt>Review window</dt>
                  <dd>48 hours after delivery submission</dd>
                </dl>
                {view === "checkout" ? (
                  <label className="consent">
                    <input
                      type="checkbox"
                      checked={policy}
                      onChange={(e) => setPolicy(e.target.checked)}
                    />
                    <span>
                      I understand the scope, deadlines, refund eligibility, and
                      review-timeout release.
                    </span>
                  </label>
                ) : null}
              </section>
            </>
          ) : (
            <>
              <section className="panel preview-panel">
                <div className="row">
                  <h3>
                    {video
                      ? "Your promotional video"
                      : preview
                        ? "Your latest checked preview"
                        : "Your project preview"}
                  </h3>
                  <span className="quiet-label">
                    {artifacts.length
                      ? "Actual generated file"
                      : "Available after checks"}
                  </span>
                </div>
                {video ? (
                  <video
                    className="delivery-video"
                    controls
                    preload="metadata"
                    poster={
                      poster ? `/api/files/${poster.id}?preview=1` : undefined
                    }
                    src={`/api/files/${video.id}?preview=1`}
                  />
                ) : preview ? (
                  preview.mime.startsWith("text/html") ? (
                    <iframe
                      title="Generated artifact preview"
                      sandbox=""
                      src={preview.previewUrl}
                      className="delivery-frame"
                    />
                  ) : (
                    <img
                      className="delivery-image"
                      alt="Your actual promotional flyer"
                      src={`/api/files/${preview.id}?preview=1`}
                    />
                  )
                ) : (
                  <div className="preview-empty">
                    <div className="round-icon">
                      <ServiceIcon id={order.brief.service} size={36} />
                    </div>
                    <h2>
                      {order.work === "failed"
                        ? "Your project is saved."
                        : "Good things take a little making."}
                    </h2>
                    <p>
                      {order.work === "failed"
                        ? customerStatusText(order.error)
                        : "Your actual preview will appear after rendering and quality checks."}
                    </p>
                  </div>
                )}
              </section>
              <section className="panel">
                <h2>Your files</h2>
                {artifacts.length ? (
                  artifacts.map((a) => (
                    <a
                      className="file-row"
                      key={a.id}
                      href={"/api/files/" + a.id}
                      download={a.name}
                    >
                      <span className="file-type">
                        {a.name.split(".").pop().toUpperCase()}
                      </span>
                      <div>
                        <strong>{a.name}</strong>
                        <small>
                          {(a.size / 1024).toFixed(1)} KB · Version {a.version}
                        </small>
                      </div>
                      <Download size={18} />
                    </a>
                  ))
                ) : (
                  <p className="fine">
                    Files appear here when the worker completes its checks.
                  </p>
                )}
                {order.manifest_hash ? (
                  <details className="manifest-details">
                    <summary>Delivery commitment & checks</summary>
                    <code>{order.manifest_hash}</code>
                    <p className="fine">
                      SHA-256 of canonical manifest JSON. A version commitment,
                      not proof of quality.
                    </p>
                    <ul className="checklist">
                      {order.manifest?.checks?.map((c: any) => (
                        <li key={c.name}>
                          <Check size={15} />
                          {c.name}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </section>
            </>
          )}
        </div>
        <aside className="scope-panel">
          {isReview ? (
            <>
              <Scope id={order.brief.service}>
                <dl className="checkout-network">
                  <dt>Network</dt>
                  <dd>QIE Mainnet</dd>
                  <dt>Payment status</dt>
                  <dd>{order.payment}</dd>
                  <dt>Asset</dt>
                  <dd>QUSDC · 6 decimals</dd>
                  <dt>Network fee</dt>
                  <dd>Wallet estimate before signing</dd>
                </dl>
                <p className="fine break">
                  Payer: {session.wallet}
                  <br />
                  Escrow: {paymentInfo?.escrow || "Awaiting verified checkout"}
                </p>
                {paymentInfo?.enabled === false ? (
                  <div className="notice">{paymentInfo.reason}</div>
                ) : null}
                {view === "review" ? (
                  <Link
                    className="button wide"
                    href={`/projects/${id}/checkout`}
                  >
                    Continue to checkout
                  </Link>
                ) : (
                  <button
                    className="button wide"
                    disabled={busy || !policy || !paymentInfo?.enabled}
                    onClick={() => void action(pay)}
                  >
                    {busy ? "Working…" : "Approve & fund 1 QUSDC"}
                  </button>
                )}
                {paymentStep ? (
                  <p className="fine" role="status">
                    {paymentStep}
                  </p>
                ) : null}
                {tx ? (
                  <p className="fine break">
                    Pending transaction: {tx}
                    <button
                      className="button light wide"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await api("orders/" + id + "/payment-sync", {
                            txHash: tx,
                          });
                          router.push("/projects/" + id);
                        })
                      }
                    >
                      Recheck saved payment
                    </button>
                  </p>
                ) : null}
                <p className="fine">
                  A transaction hash alone does not confirm payment.
                </p>
              </Scope>
            </>
          ) : (
            <>
              <section className="panel">
                <h2>
                  {reviewable ? "A moment to review." : "Behind the scenes"}
                </h2>
                <p className="muted">
                  {reviewable
                    ? "Take a look. Tell us what you think."
                    : "A clear view of every saved step."}
                </p>
                {reviewable ? (
                  <>
                    <ul className="checklist">
                      <li>
                        <Check size={16} />
                        Required files present
                      </li>
                      <li>
                        <Check size={16} />
                        Version & checksums recorded
                      </li>
                      <li>
                        <Check size={16} />
                        Approved business details preserved
                      </li>
                    </ul>
                    <div className="notice">
                      <strong>Review deadline</strong>
                      <br />
                      {delivered
                        ? date(order.review_due)
                        : "Starts after delivery confirmation"}
                      <br />
                      <small>{order.review_due}</small>
                    </div>
                    {!delivered ? (
                      <div className="notice" role="status">
                        Your files are ready. Delivery confirmation on QIE is
                        pending. Accept delivery becomes available after
                        confirmation. You can report a problem now.
                      </div>
                    ) : null}
                    {order.work !== "closed" ? (
                      <>
                        <button
                          className="button wide"
                          disabled={busy || !delivered}
                          onClick={() => setAccept(true)}
                        >
                          Accept delivery <Check size={17} />
                        </button>
                        <button
                          className="button light wide"
                          onClick={() => setProblem(true)}
                        >
                          <MessageCircle size={16} />
                          Report a problem
                        </button>
                      </>
                    ) : (
                      <div className="success-message">
                        <Check size={18} />
                        {order.payment === "refunded"
                          ? "Payment refunded"
                          : "Delivery accepted"}{" "}
                        · confirmed settlement
                      </div>
                    )}
                  </>
                ) : (
                  <div className="timeline">
                    {[
                      "brief",
                      "queued",
                      "generate",
                      "render",
                      "check",
                      "deliver",
                    ].map((stage) => {
                      const ev = events.filter((e) => e.stage === stage).at(-1);
                      return (
                        <div
                          className={ev ? "event done" : "event"}
                          key={stage}
                        >
                          <span>{ev ? <Check size={12} /> : <span />}</span>
                          <div>
                            <strong>
                              {
                                (
                                  {
                                    brief: "Brief validated",
                                    queued: "Queued for the studio",
                                    generate: "Preparing content",
                                    render: "Rendering your files",
                                    check: "Quality checks",
                                    deliver: "Ready for review",
                                  } as any
                                )[stage]
                              }
                            </strong>
                            {ev ? (
                              <>
                                <p>{customerStatusText(ev.message)}</p>
                                <small>{date(ev.created_at)}</small>
                              </>
                            ) : (
                              <p>Waiting for this stage</p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {!reviewable && order.payment === "funded" ? (
                  <button
                    className="button light wide"
                    onClick={() => setProblem(true)}
                  >
                    <MessageCircle size={16} />
                    Report a problem
                  </button>
                ) : null}
                <div className="rule" />
                <dl className="checkout-network">
                  <dt>Service price</dt>
                  <dd>1 QUSDC</dd>
                  <dt>Payment status</dt>
                  <dd>{order.payment}</dd>
                  <dt>Deliver by</dt>
                  <dd>{date(order.delivery_due)}</dd>
                </dl>
                {order.mode === "live" &&
                order.payment === "funded" &&
                !delivered &&
                order.delivery_due &&
                Date.parse(order.delivery_due) <= Date.now() ? (
                  <div className="notice">
                    <strong>Late delivery refund is eligible.</strong>
                    <p>
                      Returns 1 QUSDC to the recorded customer. QIE network fees
                      apply.
                    </p>
                    <button
                      className="button light wide"
                      disabled={busy}
                      onClick={() => void action(claimLateRefund)}
                    >
                      Claim late refund in wallet
                    </button>
                  </div>
                ) : null}
                <p className="fine">Updated {date(order.updated_at)}</p>
                <button
                  className="inline-button"
                  onClick={() => void action(refresh)}
                >
                  <RefreshCw size={14} />
                  Refresh saved status
                </button>
                {order.tx_hash &&
                order.mode === "live" &&
                ["funded", "released", "refunded"].includes(order.payment) ? (
                  <a
                    className="text-link"
                    href={`https://mainnet.qie.digital/tx/${order.tx_hash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Verified funding receipt <ExternalLink size={14} />
                  </a>
                ) : null}
              </section>
              <section className="panel small-panel">
                <h3>Your brief, always close.</h3>
                <p>
                  {order.brief.businessName}
                  <br />
                  {service.name}
                </p>
                <Link className="text-link" href={`/projects/${id}/review`}>
                  View approved brief
                </Link>
              </section>
            </>
          )}
        </aside>
      </div>
      {accept ? (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="accept-title"
            onKeyDown={(e) => {
              trapModalFocus(e);
              if (e.key === "Escape" && !busy) setAccept(false);
            }}
          >
            <div className="round-icon">
              <Check size={26} />
            </div>
            <h2 id="accept-title">Happy with your delivery?</h2>
            <p>
              Confirming acceptance requests an on-chain release of 1 QUSDC to
              the fixed Forma treasury. This cannot be refunded afterward.
            </p>
            <p className="fine">
              Review deadline: {date(order.review_due)}.{" "}
              {order.mode === "live" ? "QIE network fees apply." : ""}
            </p>
            <ErrorMessage error={error} />
            <button
              autoFocus
              className="button wide"
              disabled={busy}
              onClick={() => void action(acceptDelivery)}
            >
              {busy ? "Confirming…" : "Confirm acceptance"}
            </button>
            <button
              className="button light wide"
              disabled={busy}
              onClick={() => setAccept(false)}
            >
              Keep reviewing
            </button>
          </section>
        </div>
      ) : null}
      {problem ? (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="issue-title"
            onKeyDown={(e) => {
              trapModalFocus(e);
              if (e.key === "Escape" && !busy) setProblem(false);
            }}
          >
            <h2 id="issue-title">Let’s understand the problem.</h2>
            {issueSaved ? (
              <div className="success-message">
                Your issue is saved for review. This does not change the review
                deadline or initiate a refund.
              </div>
            ) : (
              <>
                <p>
                  Tell us what differs from your approved brief. Revisions are
                  not included automatically.
                </p>
                <label className="field">
                  <span>What needs attention?</span>
                  <textarea
                    autoFocus
                    rows={5}
                    value={issue}
                    onChange={(e) => setIssue(e.target.value)}
                    maxLength={3000}
                  />
                </label>
                <ErrorMessage error={error} />
                <button
                  className="button wide"
                  disabled={busy || issue.trim().length < 10}
                  onClick={() =>
                    void action(async () => {
                      await api("orders/" + id + "/issues", {
                        description: issue,
                      });
                      setIssueSaved(true);
                    })
                  }
                >
                  Save problem report
                </button>
              </>
            )}
            <button
              className="button light wide"
              onClick={() => setProblem(false)}
            >
              Back to delivery
            </button>
          </section>
        </div>
      ) : null}
    </Workspace>
  );
}

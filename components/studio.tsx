"use client";
import Link from "next/link";
import { stringToHex } from "viem";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import {
  X,
  Menu,
  LayoutDashboard,
  Plus,
  FolderOpen,
  HelpCircle,
  Wallet,
  Check,
  Globe,
  Play,
  Layers,
  ChartNoAxesColumnIncreasing,
  ShieldCheck,
  ArrowDownToLine,
} from "lucide-react";
import { services, type ServiceId } from "@/lib/domain";
export async function api<T = any>(
  url: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const r = await fetch("/api/" + url, {
    method: method || (body === undefined ? "GET" : "POST"),
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const result = await r.json();
  if (!r.ok) {
    const error: any = new Error(result.error || "Request failed");
    error.fields = result.fields;
    throw error;
  }
  return result;
}
type Session = {
  authenticated: boolean;
  mode: "live";
  generation?: "template" | "openai";
  liveEnabled?: boolean;
  generationAuthorized?: boolean;
  wallet?: string;
  workspaceId?: string;
  admin?: boolean;
};
const SessionContext = createContext<{
  session: Session;
  refresh: () => Promise<void>;
  connect: () => void;
}>({
  session: { authenticated: false, mode: "live" },
  refresh: async () => {},
  connect: () => {},
});
export const useSession = () => useContext(SessionContext);
export function GenerationNote() {
  const { session } = useSession();
  return (
    <>
      {!session.generation
        ? "Checking studio availability…"
        : session.generationAuthorized
          ? "Review your AI-assisted delivery before publishing."
          : "Generation is temporarily unavailable."}
    </>
  );
}
export function trapModalFocus(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== "Tab") return;
  const targets = Array.from(
    e.currentTarget.querySelectorAll<HTMLElement>(
      'button,a[href],input,textarea,select,[tabindex="0"]',
    ),
  ).filter((el) => !el.hasAttribute("disabled") && el.getClientRects().length);
  if (!targets.length) return;
  const first = targets[0],
    last = targets[targets.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: any[] }) => Promise<any>;
    };
  }
}
export function Logo() {
  return (
    <Link href="/" className="logo" aria-label="Forma home">
      <span className="brand-mark" />
      forma<span className="logo-period">.</span>
    </Link>
  );
}
export function Providers({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>({
      authenticated: false,
      mode: "live",
    }),
    [modal, setModal] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const refresh = async () => {
    const s = await api<Session>("auth/session");
    setSession(s);
  };
  useEffect(() => {
    void refresh().catch(() => {});
  }, []);
  async function wallet() {
    setBusy(true);
    setError("");
    try {
      if (!window.ethereum)
        throw new Error(
          "Install an Ethereum-compatible wallet extension to connect.",
        );
      const [address] = await window.ethereum.request({
        method: "eth_requestAccounts",
      });
      const challenge = await api("auth/nonce", { wallet: address });
      const signature = await window.ethereum.request({
        method: "personal_sign",
        params: [stringToHex(challenge.message), address],
      });
      await api("auth/verify", { nonce: challenge.nonce, signature });
      await refresh();
      setModal(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <SessionContext.Provider
      value={{
        session,
        refresh,
        connect: () => {
          setModal(true);
          setError("");
        },
      }}
    >
      {children}
      {modal ? (
        <div
          className="modal-backdrop"
          onClick={() => !busy && setModal(false)}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="connect-title"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              trapModalFocus(e);
              if (e.key === "Escape" && !busy) setModal(false);
            }}
          >
            <button
              autoFocus
              className="icon-button close"
              aria-label="Close sign-in"
              onClick={() => setModal(false)}
            >
              <X size={22} />
            </button>
            <div className="round-icon">
              <Wallet size={26} />
            </div>
            <h2 id="connect-title">Your own little studio.</h2>
            <p>
              Sign in to keep your briefs, brand kit, and projects together.
            </p>
            <ErrorMessage error={error} />
            <button
              className="button ink wide"
              disabled={busy}
              onClick={wallet}
            >
              {busy ? "Connecting…" : "Connect & sign in with wallet"}
            </button>
            <p className="fine">
              <ShieldCheck size={15} /> Signing in does not request a
              transaction.
            </p>
          </section>
        </div>
      ) : null}
    </SessionContext.Provider>
  );
}
export function WalletButton() {
  const { session, connect, refresh } = useSession();
  const [open, setOpen] = useState(false);
  if (!session.authenticated)
    return (
      <button className="button light wallet-button" onClick={connect}>
        <Wallet size={17} />
        <span>Connect wallet</span>
      </button>
    );
  return (
    <div className="account">
      <button
        className="button light wallet-button"
        onClick={() => setOpen(!open)}
      >
        <span className="avatar">{"W"}</span>
        <span>
          {session.wallet
            ? `${session.wallet.slice(0, 6)}…${session.wallet.slice(-4)}`
            : "Wallet account"}
        </span>
      </button>
      {open ? (
        <div className="account-menu">
          <p>{"Wallet authenticated"}</p>
          <button
            onClick={async () => {
              await api("auth/logout", {});
              for (const key of Object.keys(localStorage))
                if (
                  key.startsWith("forma-draft-v1-" + session.workspaceId + "-")
                )
                  localStorage.removeItem(key);
              await refresh();
              setOpen(false);
              window.location.href = "/";
            }}
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
export function Header() {
  const [menu, setMenu] = useState(false);
  return (
    <header className="site-header">
      <Logo />
      <nav
        className={menu ? "top-nav open" : "top-nav"}
        aria-label="Main navigation"
      >
        <Link href="/#services" onClick={() => setMenu(false)}>
          Services
        </Link>
        <Link href="/#how-it-works" onClick={() => setMenu(false)}>
          How it works
        </Link>
        <Link href="/projects" onClick={() => setMenu(false)}>
          My projects
        </Link>
      </nav>
      <div className="header-actions">
        <WalletButton />
        <button
          className="icon-button mobile-menu"
          aria-label="Toggle navigation"
          aria-expanded={menu}
          onClick={() => setMenu(!menu)}
        >
          <Menu size={22} />
        </button>
      </div>
    </header>
  );
}
export function Workspace({
  children,
  title = "Workspace",
}: {
  children: ReactNode;
  title?: string;
}) {
  const pathname = usePathname();
  const { session } = useSession();
  const links = [
    { href: "/", label: "Overview", icon: LayoutDashboard },
    { href: "/new", label: "New project", icon: Plus },
    { href: "/projects", label: "My projects", icon: FolderOpen },
    { href: "/help", label: "Help & guides", icon: HelpCircle },
  ];
  return (
    <div className="workspace">
      <aside className="sidebar">
        <Logo />
        <p className="eyebrow side-label">Your studio</p>
        <nav aria-label="Workspace navigation">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={
                (
                  l.href === "/new"
                    ? pathname === "/new"
                    : l.href === "/projects"
                      ? pathname.startsWith("/projects")
                      : pathname === l.href
                )
                  ? "active"
                  : ""
              }
            >
              <l.icon size={19} />
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="side-bottom">
          <div className="side-note">
            <span className="tiny-spark">✳</span>
            <p>
              A little help.
              <br />A bigger business.
            </p>
          </div>
          <span className="fine">
            Made for your business
            <br />
            Secure QUSDC checkout
          </span>
          {session.admin ? <Link href="/admin">Owner dashboard</Link> : null}
        </div>
      </aside>
      <div className="workspace-main">
        <header className="workspace-header">
          <div className="mobile-logo">
            <Logo />
          </div>
          <p className="breadcrumb">
            Workspace <span>/</span> <strong>{title}</strong>
          </p>
          <div className="header-actions">
            <WalletButton />
          </div>
        </header>
        <nav className="mobile-work-nav">
          <Link href="/">Studio</Link>
          <Link href="/new">New project</Link>
          <Link href="/projects">Projects</Link>
          <Link href="/help">Help</Link>
        </nav>
        <main className="workspace-content">{children}</main>
      </div>
    </div>
  );
}
export function ErrorMessage({ error }: { error?: string }) {
  return error ? (
    <div className="error-message" role="alert">
      {error}
    </div>
  ) : null;
}
export function ServiceIcon({ id, size = 22 }: { id: string; size?: number }) {
  const Icon =
    id === "business_website"
      ? Globe
      : id === "promo_video"
        ? Play
        : id === "flyers_price_list"
          ? Layers
          : ChartNoAxesColumnIncreasing;
  return <Icon size={size} strokeWidth={1.6} />;
}
export function ServiceTabs({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (id: ServiceId) => void;
}) {
  return (
    <div className="service-tabs" role="tablist" aria-label="Service">
      {services.map((s) => (
        <button
          role="tab"
          aria-selected={s.id === selected}
          key={s.id}
          className={s.id === selected ? "selected" : ""}
          onClick={() => onSelect(s.id)}
        >
          <ServiceIcon id={s.id} size={16} />
          {s.name}
        </button>
      ))}
    </div>
  );
}
export function Steps({ step }: { step: number }) {
  return (
    <ol className="steps">
      {["Your brief", "Review", "Payment"].map((label, i) => (
        <li
          key={label}
          className={i + 1 === step ? "current" : i + 1 < step ? "done" : ""}
        >
          <span>{i + 1 < step ? <Check size={14} /> : i + 1}</span>
          {label}
        </li>
      ))}
    </ol>
  );
}
export function Scope({ id, children }: { id: string; children?: ReactNode }) {
  const s = services.find((s) => s.id === id) || services[0];
  return (
    <aside className="scope-panel">
      <div className="panel">
        <span className="eyebrow">Your project</span>
        <MiniArtwork service={s.id} />
        <h2>{s.name}</h2>
        <ul className="checklist">
          {s.outputs.map((output) => (
            <li key={output}>
              <Check size={16} />
              <span>{output}</span>
            </li>
          ))}
        </ul>
        <div className="cost">
          <span>Launch price</span>
          <strong>
            1 <small>QUSDC</small>
          </strong>
        </div>
        <p className="fine">Approximately $1 · network fees separate</p>
        {children}
      </div>
      <p className="scope-help">
        <HelpCircle size={15} />
        <Link href="/help">What makes a good brief?</Link>
      </p>
    </aside>
  );
}
export function MiniArtwork({
  service,
  hero = false,
}: {
  service: string;
  hero?: boolean;
}) {
  return (
    <div
      className={`artwork ${service} ${hero ? "hero-art" : ""}`}
      aria-label="Service illustration"
    >
      {service === "business_website" ? (
        <div className="mini-site">
          <div className="mini-site-nav">
            YOUR BUSINESS <span>About　Services</span>
          </div>
          <div className="mini-site-title">
            Your business.
            <br />
            Online.
          </div>
          <span className="mini-caption">Built around your story.</span>
          <div className="bread">
            <i />
            <i />
            <i />
          </div>
        </div>
      ) : service === "promo_video" ? (
        <div className="mini-video">
          <span>YOUR NEXT BIG MOMENT</span>
          <strong>
            Make them
            <br />
            <em>stop scrolling.</em>
          </strong>
          <div className="sample-play">
            <Play size={18} fill="currentColor" />
          </div>
          <span className="mini-video-bottom">CREATIVE STUDIO / 9:16</span>
        </div>
      ) : service === "flyers_price_list" ? (
        <div className="mini-flyer">
          <span>FRESH THIS WEEK</span>
          <strong>
            GOOD
            <br />
            TASTE.
            <br />
            GREAT
            <br />
            PRICES.
          </strong>
          <span>GOOD THINGS, MADE FOR YOU.</span>
        </div>
      ) : (
        <div className="mini-report">
          <span>MARKET SNAPSHOT</span>
          <strong>
            Know your
            <br />
            next move.
          </strong>
          <div className="chart-bars">
            {[24, 42, 34, 62, 80].map((h, i) => (
              <i key={i} style={{ height: h + "%" }} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
export function DownloadIcon() {
  return <ArrowDownToLine size={18} />;
}

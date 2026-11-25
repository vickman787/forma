"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, Upload, Plus, Trash2, Bookmark, Palette } from "lucide-react";
import {
  blankBrief,
  briefSchema,
  getService,
  serviceIds,
  type Brief,
  type ServiceId,
} from "@/lib/domain";
import {
  api,
  Workspace,
  ServiceTabs,
  Steps,
  Scope,
  ErrorMessage,
  useSession,
} from "./studio";
export function BriefForm() {
  const params = useSearchParams(),
    router = useRouter(),
    { session, connect } = useSession();
  const editId = params.get("edit");
  const localKey =
    "forma-draft-v1-" +
    (session.authenticated ? session.workspaceId : "guest") +
    "-";
  const selected = (serviceIds as readonly string[]).includes(
    params.get("service") || "",
  )
    ? (params.get("service") as ServiceId)
    : "business_website";
  const [brief, setBrief] = useState<Brief>(() => blankBrief(selected)),
    [error, setError] = useState(""),
    [fields, setFields] = useState<Record<string, string[]>>({}),
    [busy, setBusy] = useState(false),
    [saveStatus, setSaveStatus] = useState(""),
    [ready, setReady] = useState(false),
    [kit, setKit] = useState<any>(null),
    [assets, setAssets] = useState<string[]>([]),
    [approved, setApproved] = useState(false);
  const briefRef = useRef(brief);
  briefRef.current = brief;
  useEffect(() => {
    let alive = true;
    setReady(false);
    setFields({});
    setError("");
    const load = async () => {
      let saved: any = null;
      if (session.authenticated) {
        saved = await api(`drafts/${selected}`);
        if (!saved) {
          try {
            saved = JSON.parse(
              localStorage.getItem("forma-draft-v1-guest-" + selected) ||
                "null",
            );
          } catch {}
        }
        const brand = await api("brand-kit");
        if (alive) setKit(brand);
      } else {
        try {
          saved = JSON.parse(
            localStorage.getItem(localKey + selected) || "null",
          );
        } catch {}
      }
      if (editId && session.authenticated) {
        const original = await api("orders/" + editId);
        saved = original.brief;
      }
      if (alive) {
        setBrief({ ...blankBrief(selected), ...saved, service: selected });
        setApproved(!!saved?.consent);
        setReady(true);
      }
    };
    void load().catch(() => {
      if (alive) {
        let cached: any = null;
        try {
          cached = JSON.parse(
            localStorage.getItem(localKey + selected) || "null",
          );
        } catch {}
        setBrief({ ...blankBrief(selected), ...cached, service: selected });
        setApproved(!!cached?.consent);
        setReady(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [selected, session.authenticated, session.workspaceId, editId]);
  useEffect(() => {
    if (!ready) return;
    setSaveStatus("Saving…");
    const timer = setTimeout(() => {
      const data = { ...brief, consent: approved };
      localStorage.setItem(localKey + selected, JSON.stringify(data));
      if (session.authenticated)
        void api(`drafts/${selected}`, data, "PUT")
          .then(() => {
            localStorage.removeItem("forma-draft-v1-guest-" + selected);
            setSaveStatus("Draft saved to your workspace");
          })
          .catch(() =>
            setSaveStatus("Saved in this browser · server unavailable"),
          );
      else setSaveStatus("Draft saved in this browser");
    }, 700);
    return () => clearTimeout(timer);
  }, [
    brief,
    ready,
    session.authenticated,
    session.workspaceId,
    selected,
    approved,
  ]);
  const update = (key: keyof Brief, value: any) =>
    setBrief((b) => ({ ...b, [key]: value }));
  async function review() {
    setError("");
    setFields({});
    const parsed = briefSchema.safeParse({ ...brief, consent: approved });
    if (!parsed.success) {
      setFields(parsed.error.flatten().fieldErrors);
      setError("A few details need your attention. Your draft is saved.");
      document
        .getElementById("brief-errors")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (!session.authenticated) {
      connect();
      return;
    }
    setBusy(true);
    try {
      const q = await api("quotes", parsed.data),
        o = await api("orders", { quoteId: q.id });
      router.push(`/projects/${o.id}/review`);
    } catch (e) {
      setError((e as Error).message);
      setFields((e as any).fields || {});
    } finally {
      setBusy(false);
    }
  }
  async function upload(file: File | undefined) {
    if (!file) return;
    if (!session.authenticated) {
      connect();
      return;
    }
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const r = await fetch("/api/uploads", { method: "POST", body: form }),
        a = await r.json();
      if (!r.ok) throw new Error(a.error);
      update("assetIds", [...brief.assetIds, a.id]);
      setAssets((v) => [...v, a.name]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const field = (
    key: keyof Brief,
    label: string,
    placeholder: string,
    extra?: { multiline?: boolean; optional?: boolean },
  ) => (
    <label className={extra?.multiline ? "field full" : "field"} key={key}>
      <span>
        {label}
        {extra?.optional ? <small>optional</small> : null}
      </span>
      {extra?.multiline ? (
        <textarea
          aria-invalid={!!fields[key]}
          value={String(brief[key])}
          onChange={(e) => update(key, e.target.value)}
          placeholder={placeholder}
          rows={4}
          maxLength={
            key === "description" ? 1400 : key === "referenceStyle" ? 300 : 500
          }
        />
      ) : (
        <input
          aria-invalid={!!fields[key]}
          value={String(brief[key])}
          onChange={(e) => update(key, e.target.value)}
          placeholder={placeholder}
          maxLength={
            key === "businessName" ? 80 : key === "contact" ? 180 : 300
          }
        />
      )}{" "}
      {key === "referenceStyle" ? (
        <span className="fine">{String(brief[key]).length}/300 characters</span>
      ) : null}
      {fields[key] ? (
        <span className="field-error">{fields[key][0]}</span>
      ) : null}
    </label>
  );
  return (
    <Workspace title="New project">
      <div id="main-content" className="page-title">
        <div>
          <span className="eyebrow">A good idea starts here</span>
          <h1>Let’s make something good.</h1>
          <p>
            Start with a little about your business. We’ll take it from there.
          </p>
        </div>
        <span className="quiet-label">Made around your business</span>
      </div>
      <ServiceTabs
        selected={selected}
        onSelect={(id) => {
          localStorage.setItem(
            localKey + selected,
            JSON.stringify({ ...brief, consent: approved }),
          );
          router.push("/new?service=" + id);
        }}
      />
      <div className="two-column">
        <section className="panel brief-panel">
          <Steps step={1} />
          <div className="panel-heading">
            <h2>Tell us about your business</h2>
            <p>The details that make it yours.</p>
          </div>
          <div id="brief-errors">
            <ErrorMessage error={error} />
          </div>
          {kit ? (
            <div className="kit-notice">
              <Palette size={21} />
              <div>
                <strong>Your brand kit is ready</strong>
                <p>Use your approved details for this brief.</p>
              </div>
              <button
                className="button light small"
                onClick={() => {
                  setBrief((b) => ({
                    ...b,
                    ...kit.data,
                    service: selected,
                    consent: false,
                  }));
                  setApproved(false);
                }}
              >
                Use this kit
              </button>
            </div>
          ) : null}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void review();
            }}
          >
            <div className="form-grid">
              {field("businessName", "Business name", "e.g. Sunday Crumb")}
              {field("industry", "Industry", "e.g. Food & bakery")}
              {field(
                "description",
                "What does your business do?",
                "Tell us what you make, what matters to you, and what you’d like us to create.",
                { multiline: true },
              )}
              {field("location", "Location", "City, country")}
              {field(
                "contact",
                "Approved business contact",
                "Email or phone number",
                { optional: true },
              )}
              {field(
                "audience",
                "Who are your customers?",
                "e.g. Busy professionals in Lagos",
              )}
              {field("cta", "Call to action", "e.g. Order on WhatsApp")}
              <label className="field">
                <span>Brand color</span>
                <div className="color-picker">
                  <input
                    type="color"
                    value={brief.color}
                    onChange={(e) => update("color", e.target.value)}
                    aria-label="Choose brand color"
                  />
                  <span>{brief.color.toUpperCase()}</span>
                  <div className="swatches">
                    {["#684425", "#24444C", "#D75B3E"].map((c) => (
                      <button
                        type="button"
                        key={c}
                        style={{ background: c }}
                        onClick={() => update("color", c)}
                        aria-label={`Use color ${c}`}
                      />
                    ))}
                  </div>
                </div>
              </label>
              <div className="field">
                <span>
                  Logo & photos <small>optional</small>
                </span>
                <label
                  className="upload"
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.currentTarget
                        .querySelector<HTMLInputElement>("input")
                        ?.click();
                    }
                  }}
                >
                  <Upload size={18} />
                  <span>
                    Add approved files <small>PNG, JPG · up to 5 MB</small>
                  </span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg"
                    disabled={busy || brief.assetIds.length >= 6}
                    onChange={(e) => void upload(e.target.files?.[0])}
                  />
                </label>
                {brief.assetIds.length ? (
                  <span className="fine">
                    {brief.assetIds.length} approved file(s) attached{" "}
                    <button
                      type="button"
                      className="inline-button"
                      onClick={() => {
                        update("assetIds", []);
                        setAssets([]);
                      }}
                    >
                      Clear
                    </button>
                  </span>
                ) : null}
              </div>
            </div>
            <div className="rule" />
            <div className="panel-heading">
              <h2>
                {selected === "business_website"
                  ? "A home for your business"
                  : selected === "promo_video"
                    ? "Your message, in motion"
                    : selected === "flyers_price_list"
                      ? "Your offer & exact prices"
                      : "What would you like to know?"}
              </h2>
              <p>{getService(selected).outputs[0]}</p>
            </div>
            {selected === "business_website" ? (
              <div className="field">
                <span>
                  Website sections <small>Choose up to six</small>
                </span>
                <div className="section-options">
                  {[
                    "Welcome",
                    "About",
                    "Services",
                    "Menu & prices",
                    "Gallery",
                    "Contact",
                  ].map((section) => (
                    <label key={section}>
                      <input
                        type="checkbox"
                        checked={brief.sections.includes(section as any)}
                        onChange={(e) =>
                          update(
                            "sections",
                            e.target.checked
                              ? [...brief.sections, section]
                              : brief.sections.filter((s) => s !== section),
                          )
                        }
                      />
                      {section}
                    </label>
                  ))}
                </div>
                {fields.sections ? (
                  <span className="field-error">{fields.sections[0]}</span>
                ) : null}
              </div>
            ) : null}
            {selected === "promo_video" || selected === "flyers_price_list"
              ? field(
                  "offer",
                  "Your offer or main message",
                  "Use the words and details you want your customers to see.",
                  { multiline: true },
                )
              : null}
            {selected === "business_website"
              ? field(
                  "referenceStyle",
                  "Reference style",
                  "e.g. Editorial, warm, spacious",
                  { multiline: true, optional: true },
                )
              : null}
            {selected === "promo_video"
              ? field("tone", "Tone", "e.g. Warm and welcoming")
              : null}
            {selected === "flyers_price_list"
              ? field(
                  "expiry",
                  "Real offer expiry",
                  "YYYY-MM-DD, or leave blank",
                  { optional: true },
                )
              : null}
            {selected === "flyers_price_list" ||
            (selected === "business_website" &&
              brief.sections.includes("Menu & prices")) ? (
              <div className="price-editor">
                <div className="row">
                  <label>
                    Exact price list <small>Up to 20 items</small>
                  </label>
                  <button
                    type="button"
                    className="button light small"
                    disabled={brief.items.length >= 20}
                    onClick={() =>
                      update("items", [
                        ...brief.items,
                        { name: "", currency: "NGN", price: "" },
                      ])
                    }
                  >
                    <Plus size={15} />
                    Add item
                  </button>
                </div>
                {brief.items.map((item, i) => (
                  <div className="price-input-row" key={i}>
                    <input
                      aria-label={`Item ${i + 1} name`}
                      value={item.name}
                      placeholder="Item name"
                      maxLength={100}
                      onChange={(e) =>
                        update(
                          "items",
                          brief.items.map((x, j) =>
                            i === j ? { ...x, name: e.target.value } : x,
                          ),
                        )
                      }
                    />
                    <input
                      aria-label={`Item ${i + 1} currency`}
                      value={item.currency}
                      placeholder="NGN"
                      maxLength={16}
                      onChange={(e) =>
                        update(
                          "items",
                          brief.items.map((x, j) =>
                            i === j ? { ...x, currency: e.target.value } : x,
                          ),
                        )
                      }
                    />
                    <input
                      aria-label={`Item ${i + 1} exact price`}
                      value={item.price}
                      placeholder="2,500"
                      maxLength={40}
                      onChange={(e) =>
                        update(
                          "items",
                          brief.items.map((x, j) =>
                            i === j ? { ...x, price: e.target.value } : x,
                          ),
                        )
                      }
                    />
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Remove item ${i + 1}`}
                      onClick={() =>
                        update(
                          "items",
                          brief.items.filter((_, j) => i !== j),
                        )
                      }
                    >
                      <Trash2 size={17} />
                    </button>
                  </div>
                ))}
                {fields.items ? (
                  <p className="field-error">
                    Check every item, price, and currency. At least one item is
                    required for a flyer.
                  </p>
                ) : null}
                <p className="fine">
                  We preserve these values exactly. No invented prices or
                  discounts.
                </p>
              </div>
            ) : null}
            {selected === "market_report" ? (
              <>
                {field(
                  "question",
                  "Your research question",
                  "e.g. How can a small bakery stand out in Yaba, Lagos?",
                  { multiline: true },
                )}
                <label className="field full">
                  <span>
                    Competitors <small>Up to three, one per line</small>
                  </span>
                  <textarea
                    value={brief.competitors.join("\n")}
                    rows={3}
                    onChange={(e) =>
                      update(
                        "competitors",
                        e.target.value.split("\n").slice(0, 3),
                      )
                    }
                  />
                </label>
                <label className="field full">
                  <span>
                    Optional reference URLs{" "}
                    <small>Up to five public HTTP(S) URLs, one per line</small>
                  </span>
                  <textarea
                    value={brief.sources.join("\n")}
                    rows={3}
                    onChange={(e) =>
                      update(
                        "sources",
                        e.target.value.split("\n").filter(Boolean).slice(0, 5),
                      )
                    }
                  />
                  {fields.sources ? (
                    <span className="field-error">{fields.sources[0]}</span>
                  ) : null}
                </label>
                <div className="notice">
                  Reports use web research. Review source dates and evidence
                  before making business decisions.
                </div>
              </>
            ) : null}
            <div className="rule" />
            <label className="consent">
              <input
                type="checkbox"
                checked={approved}
                onChange={(e) => setApproved(e.target.checked)}
              />
              <span>
                I approve these business details and own or have permission to
                use the uploaded assets.
              </span>
            </label>
            {fields.consent ? (
              <p className="field-error">{fields.consent[0]}</p>
            ) : null}
            <div className="form-footer">
              <span className="fine">
                <Check size={14} />
                {saveStatus || "Your brief stays yours."}
              </span>
              <button className="button" type="submit" disabled={busy}>
                {busy ? "Preparing…" : "Review project"}
              </button>
            </div>
          </form>
        </section>
        <Scope id={selected}>
          <div className="notice">
            <strong>Thoughtfully bounded.</strong>
            <br />
            Just the listed deliverables, built from your approved brief. You’ll
            review everything before acceptance.
          </div>
          <button
            className="button light wide"
            disabled={!session.authenticated || busy}
            onClick={async () => {
              try {
                const {
                  service,
                  sections,
                  items,
                  offer,
                  question,
                  competitors,
                  sources,
                  consent,
                  ...brand
                } = brief;
                await api("brand-kit", brand, "PUT");
                setSaveStatus("Brand kit saved to your workspace");
                setKit({ data: brand });
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <Bookmark size={16} />
            Save reusable brand kit
          </button>
        </Scope>
      </div>
    </Workspace>
  );
}

import { z } from "zod";
import { wrapText } from "./text";
export const serviceIds = [
  "business_website",
  "promo_video",
  "flyers_price_list",
  "market_report",
] as const;
export type ServiceId = (typeof serviceIds)[number];
export const services = [
  {
    id: "business_website",
    name: "Business Website",
    short: "A beautiful home for your business.",
    description: "Thoughtfully designed. Built for every screen.",
    label: "A home for your ideas",
    outputs: [
      "Responsive one-page website",
      "Up to six sections",
      "Website preview + source ZIP",
    ],
    icon: "Globe",
    tone: "oat",
  },
  {
    id: "promo_video",
    name: "Promo Video",
    short: "Your products, in motion.",
    description: "A small film for your next big moment.",
    label: "Made to stop the scroll",
    outputs: [
      "One 12–16 second vertical MP4",
      "1080 × 1920 template video",
      "Captions TXT + poster frame",
    ],
    icon: "Play",
    tone: "sage",
  },
  {
    id: "flyers_price_list",
    name: "Flyers & Price List",
    short: "Clear prices. Standout design.",
    description: "Ready to post, share, or print.",
    label: "Good things, well presented",
    outputs: [
      "1080 × 1350 promotional PNG",
      "Matching promotional PDF",
      "A4 price-list PDF, up to 20 items",
    ],
    icon: "Layers",
    tone: "peach",
  },
  {
    id: "market_report",
    name: "Market Report",
    short: "Your market, with the evidence.",
    description: "A little clarity for your next move.",
    label: "Turn insight into opportunity",
    outputs: [
      "Short HTML + PDF market brief",
      "Up to five substantive sections",
      "Source table CSV",
    ],
    icon: "ChartNoAxesColumnIncreasing",
    tone: "blue",
  },
] as const;
export const getService = (id: string) =>
  services.find((s) => s.id === id) ?? services[0];
const text = (max: number) => z.string().trim().max(max);
export const briefSchema = z
  .object({
    service: z.enum(serviceIds),
    businessName: text(80).min(2, "Enter your business name."),
    description: text(1400).min(
      20,
      "Tell us a little more (at least 20 characters).",
    ),
    industry: text(80).min(2, "Enter an industry."),
    location: text(120).min(2, "Enter your location."),
    audience: text(300).min(3, "Describe your customers."),
    contact: text(180).refine(
      (v) => !v || /^[^<>\r\n]+$/.test(v),
      "Enter a plain email address or phone number.",
    ),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    cta: text(120).min(2, "Enter a call to action."),
    offer: text(300),
    referenceStyle: text(300).default(""),
    tone: text(80).default("Warm and welcoming"),
    expiry: text(10)
      .refine(
        (v) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v),
        "Use a real offer expiry date in YYYY-MM-DD format, or leave blank.",
      )
      .default(""),
    sections: z
      .array(
        z.enum([
          "Welcome",
          "About",
          "Services",
          "Menu & prices",
          "Gallery",
          "Contact",
        ]),
      )
      .max(6),
    items: z
      .array(
        z.object({
          name: text(100).min(1),
          price: text(40).min(1),
          currency: text(16).min(1),
        }),
      )
      .max(20),
    question: text(500),
    competitors: z.array(text(100)).max(3),
    sources: z
      .array(
        z
          .string()
          .url()
          .max(500)
          .refine((v) => /^https?:\/\//.test(v), "Use a public HTTP(S) URL."),
      )
      .max(5),
    assetIds: z.array(z.string().uuid()).max(6).default([]),
    consent: z.literal(true, {
      error: "Confirm that these business details are approved.",
    }),
  })
  .superRefine((b, c) => {
    if (b.service === "business_website" && !b.sections.length)
      c.addIssue({
        code: "custom",
        path: ["sections"],
        message: "Choose at least one section.",
      });
    if (b.service === "market_report" && b.question.length < 10)
      c.addIssue({
        code: "custom",
        path: ["question"],
        message: "Enter a specific research question.",
      });
    if (b.service === "flyers_price_list" && !b.items.length)
      c.addIssue({
        code: "custom",
        path: ["items"],
        message: "Add at least one item and its exact price.",
      });
    if (b.service === "promo_video" && b.offer.length < 5)
      c.addIssue({
        code: "custom",
        path: ["offer"],
        message: "Describe the offer or message for your video.",
      });
    if (new Set(b.sections).size !== b.sections.length)
      c.addIssue({
        code: "custom",
        path: ["sections"],
        message: "Choose each section only once.",
      });
    if (b.service === "flyers_price_list")
      for (const [key, maxLines, width] of [
        ["offer", 6, 20],
        ["cta", 2, 35],
        ["contact", 2, 55],
      ] as const) {
        if (wrapText(b[key], width).length > maxLines)
          c.addIssue({
            code: "custom",
            path: [key],
            message: `Shorten this text to fit the flyer safely (${maxLines} lines).`,
          });
      }
    if (b.service === "promo_video" && wrapText(b.offer, 23).length > 8)
      c.addIssue({
        code: "custom",
        path: ["offer"],
        message: "Shorten the offer to fit a vertical video scene.",
      });
  });
export type Brief = z.infer<typeof briefSchema>;
export const brandKitSchema = z.object({
  businessName: briefSchema.shape.businessName,
  description: briefSchema.shape.description,
  industry: briefSchema.shape.industry,
  location: briefSchema.shape.location,
  audience: briefSchema.shape.audience,
  contact: briefSchema.shape.contact,
  color: briefSchema.shape.color,
  cta: briefSchema.shape.cta,
  assetIds: briefSchema.shape.assetIds,
});
export const blankBrief = (service: ServiceId = "business_website"): Brief => ({
  service,
  businessName: "",
  description: "",
  industry: "",
  location: "",
  audience: "",
  contact: "",
  color: "#684425",
  cta: "Get in touch",
  offer: "",
  referenceStyle: "",
  tone: "Warm and welcoming",
  expiry: "",
  sections: ["Welcome", "About", "Services", "Contact"],
  items: [],
  question: "",
  competitors: [],
  sources: [],
  assetIds: [],
  consent: true,
});
export type WorkState =
  | "awaiting_funding"
  | "queued"
  | "running"
  | "checking"
  | "delivered"
  | "failed"
  | "closed";
export type PaymentState =
  "unfunded" | "pending" | "funded" | "unknown" | "released" | "refunded";
export const terms = {
  version: "forma-1",
  fundingMinutes: 30,
  deliveryHours: 24,
  reviewHours: 48,
  amount: "1000000",
  currency: "QUSDC",
  decimals: 6,
  chainId: 1990,
  token: "0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5",
  text: "Fund within 30 minutes. Delivery due within 24 hours of verified funding. Review within 48 hours of delivery. Accepting releases 1 QUSDC to Forma. After the review deadline anyone may trigger release; time alone does not send a transaction. Late undelivered work is eligible for a customer refund. Report problems before settlement; a report does not pause the review window. Network fees are separate.",
};
export type Order = {
  id: string;
  owner: string;
  quote_id: string;
  mode: "demo" | "live";
  generation?: "template" | "openai" | "saved_openai";
  brief: Brief;
  work: WorkState;
  payment: PaymentState;
  created_at: string;
  updated_at: string;
  funding_expires: string;
  delivery_due: string | null;
  review_due: string | null;
  manifest: any;
  manifest_hash: string | null;
  error: string | null;
  chain_job: string;
  version: number;
  tx_hash: string | null;
};
export type Artifact = {
  id: string;
  order_id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  storage_key: string;
  version: number;
};
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical((value as any)[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function escapeHtml(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

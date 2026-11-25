import { existsSync } from "node:fs";
import ffmpeg from "ffmpeg-static";
import { config } from "./config";
import { blankBrief, type ServiceId } from "./domain";
import { providerBudget } from "./provider";
export function availability(
  service: ServiceId,
  generation: "template" | "openai" | "saved_openai" = config().generation,
  orderId?: string,
) {
  const c = config();
  if (
    generation === "openai" &&
    (process.env.ALLOW_PAID_API_CALLS !== "true" ||
      ((!process.env.PROCESS_ROLE ||
        ["all", "generation"].includes(process.env.PROCESS_ROLE)) &&
        !process.env.OPENAI_API_KEY) ||
      !process.env.OPENAI_TEXT_MODEL ||
      !process.env.OPENAI_RESEARCH_MODEL)
  )
    return {
      enabled: false,
      reason:
        "AI generation needs configured credentials and explicit paid-call authorization.",
    };
  if (c.mode === "live") {
    if (
      !c.liveEnabled &&
      !(c.localOnly && c.localCheckoutOrder && orderId === c.localCheckoutOrder)
    )
      return {
        enabled: false,
        reason:
          "Live checkout awaits verified payments and explicitly authorized provider configuration.",
      };
  }
  if (generation === "openai") {
    try {
      providerBudget(blankBrief(service));
    } catch {
      return {
        enabled: false,
        reason:
          "Provider budget and rate estimates need configuration before this service can be sold.",
      };
    }
  }
  if (
    service === "promo_video" &&
    !existsSync(
      /*turbopackIgnore: true*/ process.env.FFMPEG_PATH || ffmpeg || "",
    )
  )
    return {
      enabled: false,
      reason:
        "The video renderer is unavailable. Checkout is disabled until FFmpeg is configured.",
    };
  return { enabled: true, reason: null };
}

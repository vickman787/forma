import { type Brief } from "./domain";
import { type Content } from "./provider";
/** Reject unexpected contact data and numbers in non-research generated copy. */
export function checkBusinessFacts(brief: Brief, content: Content) {
  const source = JSON.stringify([
      brief.businessName,
      brief.description,
      brief.industry,
      brief.location,
      brief.audience,
      brief.contact,
      brief.cta,
      brief.offer,
      brief.expiry,
      brief.items,
    ]),
    copy = [
      content.headline,
      content.body,
      ...content.scenes,
      ...content.sections.map((s) => s.text),
    ].join("\n");
  const emails = copy.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  if (emails.some((email) => !source.includes(email)))
    throw new Error("Generated copy introduced unapproved contact details.");
  if (brief.service !== "market_report") {
    const allowed = new Set(source.match(/\d[\d,.]*/g) || []),
      numbers = copy.match(/\d[\d,.]*/g) || [];
    if (numbers.some((n) => !allowed.has(n)))
      throw new Error(
        "Generated copy introduced an unapproved number or price.",
      );
  }
}

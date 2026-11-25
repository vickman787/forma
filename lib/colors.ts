/** WCAG relative luminance; preserve the brand color while selecting readable text. */
export function luminance(hex: string) {
  const rgb = hex
    .slice(1)
    .match(/../g)!
    .map((v) => parseInt(v, 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
export function contrast(a: string, b: string) {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function readableInk(background: string) {
  if (contrast(background, "#172B36") >= 4.5) return "#172B36";
  if (contrast(background, "#F7F5F0") >= 4.5) return "#F7F5F0";
  return contrast(background, "#000000") > contrast(background, "#FFFFFF")
    ? "#000000"
    : "#FFFFFF";
}
export function readableAccent(accent: string, background = "#F7F5F0") {
  return contrast(accent, background) >= 4.5 ? accent : "#172B36";
}

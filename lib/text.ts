export function wrapText(s: string, max = 28) {
  const result: string[] = [];
  let line = "";
  for (const word of s
    .split(/\s+/)
    .flatMap((word) =>
      word.length > max
        ? word.match(new RegExp(`.{1,${max}}`, "gu")) || []
        : [word],
    )) {
    if ((line + " " + word).trim().length > max && line) {
      result.push(line);
      line = "";
    }
    line += (line ? " " : "") + word;
  }
  if (line) result.push(line);
  return result;
}

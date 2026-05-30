export function summarizeSingleLine(text: string | undefined, maxLength = 160): string | undefined {
  const singleLine = text?.replace(/\s+/g, " ").trim();
  if (!singleLine) return undefined;
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1).trimEnd()}…`;
}

import { labelTextColor } from "./format";

// Dynamic label color registry using adoptedStyleSheets.
// This avoids inline style attributes, allowing removal of
// style-src-attr 'unsafe-inline' from the CSP.
const sheet = new CSSStyleSheet();
document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

const registered = new Set<string>();
const FALLBACK_BG = "e5e7eb";
const FALLBACK_FG = "#374151";

/**
 * Registers a label color in the adopted stylesheet and returns
 * the CSS class name. Hex values are validated before use —
 * only [0-9a-fA-F]{6} is accepted.
 */
export function labelColorClass(hex: string): string {
  const isValid = /^[0-9a-fA-F]{6}$/.test(hex);
  const safeHex = isValid ? hex.toLowerCase() : FALLBACK_BG;

  if (!registered.has(safeHex)) {
    const bg = `#${safeHex}`;
    const fg = isValid ? labelTextColor(safeHex) : FALLBACK_FG;
    sheet.insertRule(`.lb-${safeHex} { background-color: ${bg}; color: ${fg}; }`);
    registered.add(safeHex);
  }
  return `lb-${safeHex}`;
}

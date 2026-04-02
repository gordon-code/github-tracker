import { labelTextColor } from "./format";

// Dynamic label color registry using adoptedStyleSheets.
// This avoids inline style attributes, allowing removal of
// style-src-attr 'unsafe-inline' from the CSP.
let _sheet: CSSStyleSheet | null = null;

function getSheet(): CSSStyleSheet {
  if (!_sheet) {
    _sheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, _sheet];
  }
  return _sheet;
}

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
    getSheet().insertRule(`.lb-${safeHex} { background-color: ${bg}; color: ${fg}; }`);
    registered.add(safeHex);
  }
  return `lb-${safeHex}`;
}

/** Reset internal state — exposed for testing only. */
export function _resetLabelColors(): void {
  registered.clear();
  if (_sheet) {
    while (_sheet.cssRules.length > 0) _sheet.deleteRule(0);
  }
}

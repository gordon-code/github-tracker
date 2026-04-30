import { relativeTime } from "../../lib/format";

interface JiraFieldValueProps {
  value: unknown;
}

function renderScalar(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
      const rel = relativeTime(value);
      if (rel) return rel;
      const d = new Date(value);
      if (!isNaN(d.getTime())) return d.toLocaleDateString();
    }
    return value.length > 100 ? value.slice(0, 100) + "…" : value;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (typeof obj["displayName"] === "string") return obj["displayName"];
    if (typeof obj["value"] === "string") return obj["value"];
  }
  const json = JSON.stringify(value);
  return json.length > 100 ? json.slice(0, 100) + "…" : json;
}

function isOptionOrUser(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj["displayName"] === "string" || typeof obj["value"] === "string";
}

export default function JiraFieldValue(props: JiraFieldValueProps) {
  if (props.value === null || props.value === undefined) {
    return <span class="text-sm text-base-content/40">—</span>;
  }
  if (Array.isArray(props.value)) {
    const parts = (props.value as unknown[])
      .filter((el) => !Array.isArray(el))
      .map((el) => ({ text: renderScalar(el), src: el }));
    if (parts.length === 0) return <span class="text-sm text-base-content/40">—</span>;
    return (
      <span class="text-sm">
        {parts.map(({ text, src }, i) => (
          <>
            {i > 0 && <span class="text-base-content/40">, </span>}
            {isOptionOrUser(src)
              ? <span class="badge badge-sm badge-ghost">{text}</span>
              : text}
          </>
        ))}
      </span>
    );
  }
  const text = renderScalar(props.value);
  if (isOptionOrUser(props.value)) {
    return <span class="badge badge-sm badge-ghost">{text}</span>;
  }
  return <span class="text-sm">{text}</span>;
}

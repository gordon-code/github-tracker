interface ScopeToggleProps {
  value: string;
  onChange: (field: string, value: string) => void;
}

export default function ScopeToggle(props: ScopeToggleProps) {
  const checked = () => props.value === "involves_me";

  return (
    <div class="flex items-center gap-2">
      <input
        type="checkbox"
        aria-label="Scope filter"
        class="toggle toggle-sm toggle-primary"
        checked={checked()}
        onChange={(e) =>
          props.onChange("scope", e.currentTarget.checked ? "involves_me" : "all")
        }
      />
      <span class="text-sm text-base-content/70">
        {checked() ? "Involves me" : "All activity"}
      </span>
    </div>
  );
}

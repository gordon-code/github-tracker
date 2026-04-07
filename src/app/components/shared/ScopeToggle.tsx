interface ScopeToggleProps {
  value: string;
  onChange: (field: string, value: string) => void;
}

export default function ScopeToggle(props: ScopeToggleProps) {
  const checked = () => props.value === "involves_me";

  return (
    <label class="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        aria-label="Scope filter"
        class="toggle toggle-primary toggle-sm compact:toggle-xs"
        checked={checked()}
        onChange={(e) =>
          props.onChange("scope", e.currentTarget.checked ? "involves_me" : "all")
        }
      />
      <span class="text-base-content/70 text-sm compact:text-xs">
        {checked() ? "Involves me" : "All activity"}
      </span>
    </label>
  );
}

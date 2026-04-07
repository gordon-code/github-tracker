export interface FilterChipGroupDef {
  label: string;
  field: string;
  options: { value: string; label: string }[];
  defaultValue?: string; // When set, replaces "all" as the "no filter active" value
}

export const scopeFilterGroup: FilterChipGroupDef = {
  label: "Scope",
  field: "scope",
  defaultValue: "involves_me",
  options: [
    { value: "involves_me", label: "Involves me" },
    { value: "all", label: "All activity" },
  ],
};

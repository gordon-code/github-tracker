import { describe, it, expect } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import SettingRow from "../../../src/app/components/settings/SettingRow";

describe("SettingRow", () => {
  it("renders the label", () => {
    render(() => <SettingRow label="My Label"><span>ctrl</span></SettingRow>);
    screen.getByText("My Label");
  });

  it("renders children", () => {
    render(() => <SettingRow label="Label"><button>Click me</button></SettingRow>);
    screen.getByRole("button", { name: "Click me" });
  });

  it("renders description when provided", () => {
    render(() => (
      <SettingRow label="Label" description="Some description"><div /></SettingRow>
    ));
    screen.getByText("Some description");
  });

  it("does not render description element when not provided", () => {
    render(() => <SettingRow label="Label"><div /></SettingRow>);
    expect(screen.queryByText("Some description")).toBeNull();
  });
});

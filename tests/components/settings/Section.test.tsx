import { describe, it, expect } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import Section from "../../../src/app/components/settings/Section";

describe("Section", () => {
  it("renders the title", () => {
    render(() => <Section title="My Section"><div>content</div></Section>);
    screen.getByText("My Section");
  });

  it("renders children", () => {
    render(() => <Section title="Test"><span>child content</span></Section>);
    screen.getByText("child content");
  });

  it("title is rendered as an h2", () => {
    render(() => <Section title="Heading"><div /></Section>);
    expect(screen.getByRole("heading", { level: 2, name: "Heading" })).toBeDefined();
  });

  it("applies card class to root element", () => {
    const { container } = render(() => <Section title="T"><div /></Section>);
    expect(container.querySelector(".card")).not.toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import SortIcon from "../../../src/app/components/shared/SortIcon";

describe("SortIcon", () => {
  it('renders "↑" when active=false regardless of direction', () => {
    const { container } = render(() => <SortIcon active={false} direction="desc" />);
    expect(container.querySelector("span")?.textContent).toBe("↑");
  });

  it('renders "↑" when active=true and direction="asc"', () => {
    const { container } = render(() => <SortIcon active={true} direction="asc" />);
    expect(container.querySelector("span")?.textContent).toBe("↑");
  });

  it('renders "↓" when active=true and direction="desc"', () => {
    const { container } = render(() => <SortIcon active={true} direction="desc" />);
    expect(container.querySelector("span")?.textContent).toBe("↓");
  });

  it("has opacity-100 class when active", () => {
    const { container } = render(() => <SortIcon active={true} direction="asc" />);
    expect(container.querySelector("span")?.className).toContain("opacity-100");
  });

  it("has opacity-30 class when inactive", () => {
    const { container } = render(() => <SortIcon active={false} direction="asc" />);
    expect(container.querySelector("span")?.className).toContain("opacity-30");
  });
});

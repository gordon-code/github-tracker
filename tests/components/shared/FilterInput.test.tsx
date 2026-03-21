import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import FilterInput from "../../../src/app/components/shared/FilterInput";

describe("FilterInput", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("renders input with placeholder", () => {
    render(() => <FilterInput onFilter={vi.fn()} placeholder="Search..." />);
    const input = screen.getByPlaceholderText("Search...");
    expect(input).toBeTruthy();
  });

  it("renders default placeholder when none provided", () => {
    render(() => <FilterInput onFilter={vi.fn()} />);
    expect(screen.getByPlaceholderText("Filter...")).toBeTruthy();
  });

  it("onFilter is NOT called synchronously after input (debounced)", () => {
    const onFilter = vi.fn();
    render(() => <FilterInput onFilter={onFilter} />);
    const input = screen.getByPlaceholderText("Filter...");
    fireEvent.input(input, { target: { value: "hello" } });
    expect(onFilter).not.toHaveBeenCalled();
  });

  it("onFilter IS called after default debounce of 150ms", () => {
    const onFilter = vi.fn();
    render(() => <FilterInput onFilter={onFilter} />);
    const input = screen.getByPlaceholderText("Filter...");
    fireEvent.input(input, { target: { value: "hello" } });
    vi.advanceTimersByTime(150);
    expect(onFilter).toHaveBeenCalledWith("hello");
  });

  it("clear button appears when input has value and calls onFilter('') immediately", async () => {
    const onFilter = vi.fn();
    render(() => <FilterInput onFilter={onFilter} />);
    const input = screen.getByPlaceholderText("Filter...");
    fireEvent.input(input, { target: { value: "test" } });
    // Advance time to commit value to signal
    vi.advanceTimersByTime(0);

    const clearBtn = screen.getByLabelText("Clear filter");
    expect(clearBtn).toBeTruthy();
    onFilter.mockClear();

    const user = userEvent.setup({ delay: null });
    await user.click(clearBtn);
    // Called immediately, not after debounce
    expect(onFilter).toHaveBeenCalledWith("");
    expect(onFilter).toHaveBeenCalledOnce();
  });

  it("custom debounceMs prop changes timing", () => {
    const onFilter = vi.fn();
    render(() => <FilterInput onFilter={onFilter} debounceMs={300} />);
    const input = screen.getByPlaceholderText("Filter...");
    fireEvent.input(input, { target: { value: "test" } });

    vi.advanceTimersByTime(150);
    expect(onFilter).not.toHaveBeenCalled();

    vi.advanceTimersByTime(150);
    expect(onFilter).toHaveBeenCalledWith("test");
  });
});

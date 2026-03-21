import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import FilterInput from "../../../src/app/components/shared/FilterInput";

describe("FilterInput", () => {
  afterEach(() => {
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
    vi.useFakeTimers();
    const onFilter = vi.fn();
    render(() => <FilterInput onFilter={onFilter} />);
    const input = screen.getByPlaceholderText("Filter...");
    fireEvent.input(input, { target: { value: "hello" } });
    expect(onFilter).not.toHaveBeenCalled();
  });

  it("onFilter IS called after default debounce of 150ms", () => {
    vi.useFakeTimers();
    const onFilter = vi.fn();
    render(() => <FilterInput onFilter={onFilter} />);
    const input = screen.getByPlaceholderText("Filter...");
    fireEvent.input(input, { target: { value: "hello" } });
    vi.advanceTimersByTime(150);
    expect(onFilter).toHaveBeenCalledWith("hello");
  });

  it("clear button appears when input has value and calls onFilter('') immediately", () => {
    vi.useFakeTimers();
    const onFilter = vi.fn();
    render(() => <FilterInput onFilter={onFilter} />);
    const input = screen.getByPlaceholderText("Filter...");
    fireEvent.input(input, { target: { value: "test" } });
    // Advance time to commit value to signal
    vi.advanceTimersByTime(0);

    const clearBtn = screen.getByLabelText("Clear filter");
    expect(clearBtn).toBeTruthy();
    onFilter.mockClear();

    fireEvent.click(clearBtn);
    // Called immediately, not after debounce
    expect(onFilter).toHaveBeenCalledWith("");
    expect(onFilter).toHaveBeenCalledOnce();
  });

  it("custom debounceMs prop changes timing", () => {
    vi.useFakeTimers();
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

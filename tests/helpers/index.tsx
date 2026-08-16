import { render, screen } from "@solidjs/testing-library";
import { MemoryRouter, createMemoryHistory } from "@solidjs/router";
import { resetViewState } from "../../src/app/stores/view";
import type { JSX } from "solid-js";

export { makeIssue, makePullRequest, makeWorkflowRun, makeApiError, makeTrackedItem } from "./factories.js";

export function renderWithRouter(
  component: () => JSX.Element,
  initialPath = "/"
): ReturnType<typeof render> {
  const history = createMemoryHistory();
  history.set({ value: initialPath });
  return render(() => (
    <MemoryRouter history={history}>{component()}</MemoryRouter>
  ));
}

export function resetViewStore(): void {
  resetViewState();
}

export function findCheckboxByLabelText(text: string): HTMLInputElement {
  const checkbox = screen
    .getAllByRole("checkbox")
    .find((cb) => cb.closest("label")?.textContent?.includes(text));
  if (!checkbox) throw new Error(`No checkbox found for label text "${text}"`);
  return checkbox as HTMLInputElement;
}

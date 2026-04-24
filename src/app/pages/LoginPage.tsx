import { createSignal, onMount, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { setAuthFromPat, type GitHubUser } from "../stores/auth";
import {
  isValidPatFormat,
  GITHUB_PAT_URL,
  GITHUB_FINE_GRAINED_PAT_URL,
} from "../lib/pat";
import { buildAuthorizeUrl } from "../lib/oauth";

export default function LoginPage() {
  const navigate = useNavigate();

  onMount(() => {
    // Speculatively prefetch the dashboard chunk while the user is on the
    // login page. By the time they authenticate, the chunk is cached.
    const prefetch = () => {
      import("../components/dashboard/DashboardPage").catch(() => {
        console.warn("[app] Dashboard chunk prefetch failed");
      });
    };
    "requestIdleCallback" in window
      ? requestIdleCallback(prefetch)
      : setTimeout(prefetch, 2000);
  });

  const [showPatForm, setShowPatForm] = createSignal(false);
  const [patInput, setPatInput] = createSignal("");
  const [patError, setPatError] = createSignal<string | null>(null);
  const [submitting, setSubmitting] = createSignal(false);

  function handleLogin() {
    window.location.href = buildAuthorizeUrl();
  }

  async function handlePatSubmit(e: Event) {
    e.preventDefault();
    if (submitting()) return;
    const validation = isValidPatFormat(patInput());
    if (!validation.valid) {
      setPatError(validation.error);
      return;
    }
    setSubmitting(true);
    setPatError(null);
    const trimmedToken = patInput().trim();
    try {
      const resp = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${trimmedToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (!resp.ok) {
        setPatError(
          resp.status === 401
            ? "Token is invalid — check that you entered it correctly"
            : `GitHub returned ${resp.status} — try again later`
        );
        return;
      }
      if (!showPatForm()) return;
      const userData = (await resp.json()) as GitHubUser;
      setAuthFromPat(trimmedToken, userData);
      setPatInput("");
      navigate("/", { replace: true });
    } catch {
      setPatError("Network error — please try again");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div class="bg-base-200 min-h-screen flex items-center justify-center">
      <div class="card bg-base-100 shadow-xl max-w-sm w-full mx-4">
        <div class="card-body items-center text-center gap-6">

          <Show
            when={!showPatForm()}
            fallback={
              <form onSubmit={(e) => void handlePatSubmit(e)} class="w-full flex flex-col gap-4">
                <h2 class="card-title">Sign in with Token</h2>

                <div class="text-left w-full">
                  <label for="pat-input" class="label">
                    <span class="label-text">Personal access token</span>
                  </label>
                  <input
                    id="pat-input"
                    type="password"
                    autocomplete="new-password"
                    placeholder="ghp_... or github_pat_..."
                    class={`input input-bordered w-full${patError() !== null ? " input-error" : ""}`}
                    aria-invalid={patError() !== null}
                    aria-describedby={patError() !== null ? "pat-error" : undefined}
                    value={patInput()}
                    onInput={(e) => setPatInput(e.currentTarget.value)}
                  />
                  <Show when={patError() !== null}>
                    <p id="pat-error" role="alert" class="text-error text-xs mt-1">
                      {patError()}
                    </p>
                  </Show>
                </div>

                <button
                  type="submit"
                  class="btn btn-neutral w-full"
                  disabled={submitting()}
                >
                  {submitting() ? "Verifying..." : "Sign in"}
                </button>

                <div class="text-left text-xs space-y-3 mt-4">
                  <div>
                    <p class="font-medium mb-1">
                      <a
                        href={GITHUB_PAT_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="link link-primary"
                      >
                        Classic token
                      </a>
                      {" "}(recommended) — works across all orgs. Select these scopes:
                    </p>
                    <ul class="list-disc list-inside space-y-0.5 text-base-content/70">
                      <li><code>repo</code></li>
                      <li><code>read:org</code> <span class="text-base-content/40">(under admin:org)</span></li>
                    </ul>
                  </div>

                  <p class="text-base-content/50">
                    <a
                      href={GITHUB_FINE_GRAINED_PAT_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="link"
                    >
                      Fine-grained tokens
                    </a>
                    {" "}also work, but only access one org at a time. Add read-only permissions for Actions, Contents, Issues, and Pull requests.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => { setShowPatForm(false); setPatError(null); setPatInput(""); }}
                  class="link link-primary text-sm mt-2"
                >
                  Use OAuth instead
                </button>
              </form>
            }
          >
            <div class="flex flex-col items-center gap-2">
              <h1 class="card-title text-2xl">
                GitHub Tracker
              </h1>
              <p class="text-sm text-base-content/60 text-center">
                Track issues, pull requests, and workflow runs across your GitHub
                repositories.
              </p>
            </div>

            <button
              type="button"
              onClick={handleLogin}
              class="btn btn-neutral w-full"
            >
              <svg
                viewBox="0 0 16 16"
                class="w-5 h-5"
                aria-hidden="true"
                fill="currentColor"
              >
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
              </svg>
              Sign in with GitHub
            </button>

            <div class="divider text-xs text-base-content/40">or</div>
            <button
              type="button"
              onClick={() => setShowPatForm(true)}
              class="link link-primary text-sm"
            >
              Use a Personal Access Token
            </button>
          </Show>

        </div>
      </div>
    </div>
  );
}

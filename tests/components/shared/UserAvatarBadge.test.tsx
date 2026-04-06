import { describe, it, expect } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import UserAvatarBadge from "../../../src/app/components/shared/UserAvatarBadge";

describe("UserAvatarBadge", () => {
  it("renders nothing when users array is empty", () => {
    const { container } = render(() => (
      <UserAvatarBadge users={[]} currentUserLogin="me" />
    ));
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders nothing when all users are the current user", () => {
    const { container } = render(() => (
      <UserAvatarBadge
        users={[{ login: "me", avatarUrl: "https://avatars.githubusercontent.com/u/1" }]}
        currentUserLogin="me"
      />
    ));
    expect(container.querySelector("img")).toBeNull();
  });

  it("is case-insensitive when comparing logins to currentUserLogin", () => {
    const { container } = render(() => (
      <UserAvatarBadge
        users={[{ login: "Me", avatarUrl: "https://avatars.githubusercontent.com/u/1" }]}
        currentUserLogin="me"
      />
    ));
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders avatars for tracked users (not the current user)", () => {
    render(() => (
      <UserAvatarBadge
        users={[
          { login: "tracked1", avatarUrl: "https://avatars.githubusercontent.com/u/1" },
          { login: "tracked2", avatarUrl: "https://avatars.githubusercontent.com/u/2" },
        ]}
        currentUserLogin="me"
      />
    ));
    const imgs = screen.getAllByRole("img");
    expect(imgs).toHaveLength(2);
  });

  it("filters out the current user and renders only tracked users", () => {
    render(() => (
      <UserAvatarBadge
        users={[
          { login: "me", avatarUrl: "https://avatars.githubusercontent.com/u/0" },
          { login: "tracked1", avatarUrl: "https://avatars.githubusercontent.com/u/1" },
        ]}
        currentUserLogin="me"
      />
    ));
    const imgs = screen.getAllByRole("img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute("alt")).toBe("tracked1");
  });

  it("uses avatarUrl as img src", () => {
    const avatarUrl = "https://avatars.githubusercontent.com/u/583231";
    render(() => (
      <UserAvatarBadge
        users={[{ login: "octocat", avatarUrl }]}
        currentUserLogin="me"
      />
    ));
    const img = screen.getByRole("img");
    expect(img.getAttribute("src")).toBe(avatarUrl);
  });

  it("applies negative margin for stacked avatars when multiple users", () => {
    const { container } = render(() => (
      <UserAvatarBadge
        users={[
          { login: "user1", avatarUrl: "https://avatars.githubusercontent.com/u/1" },
          { login: "user2", avatarUrl: "https://avatars.githubusercontent.com/u/2" },
        ]}
        currentUserLogin="me"
      />
    ));
    // Second avatar wrapper should have a negative margin-left style
    const avatarWrappers = container.querySelectorAll(".avatar");
    expect(avatarWrappers.length).toBe(2);
    // First has no negative margin class; second does
    expect(avatarWrappers[1].classList.contains("-ml-1.5")).toBe(true);
  });
});

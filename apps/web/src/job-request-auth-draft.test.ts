import { describe, expect, it, vi } from "vitest";

import {
  createAuthBoundaryDraftCoordinator,
  type AuthBoundaryDraftStorage,
  type LocalAuthBoundaryDraft,
} from "./job-request-auth-draft.js";

const csrf = "csrf-token-with-sufficient-length";

describe("authentication-boundary job request draft", () => {
  it("keeps local content when arming fails", async () => {
    const storage = memoryStorage();
    const coordinator = createAuthBoundaryDraftCoordinator({
      clock: () => 1_000,
      maxAgeMs: 60_000,
      storage,
      transport: {
        arm: () => Promise.reject(new Error("offline")),
        consume: vi.fn(),
      },
    });

    await expect(
      coordinator.saveBeforeAuthentication(section("original"), csrf),
    ).rejects.toThrow("offline");
    await expect(storage.load()).resolves.toMatchObject({
      localRevision: 1,
      section: { payload: { description: "original" } },
    });
  });

  it("restores after authentication and clears only the exact local revision", async () => {
    const storage = memoryStorage();
    const consume = vi.fn(() =>
      Promise.resolve({
        jobRequestId: "97000000-0000-4000-8000-000000000099",
        revision: 1,
      }),
    );
    const coordinator = createAuthBoundaryDraftCoordinator({
      clock: () => 1_000,
      maxAgeMs: 60_000,
      storage,
      transport: { arm: vi.fn(() => Promise.resolve()), consume },
    });
    await coordinator.saveBeforeAuthentication(section("first"), csrf);

    await expect(coordinator.restoreAfterAuthentication(csrf)).resolves.toEqual(
      {
        clearedLocalDraft: true,
        jobRequestId: "97000000-0000-4000-8000-000000000099",
        revision: 1,
        status: "RESTORED",
      },
    );
    expect(consume).toHaveBeenCalledWith(csrf, section("first"));
    await expect(storage.load()).resolves.toBeNull();
  });

  it("does not erase a newer multi-tab edit after an older consume commits", async () => {
    const storage = memoryStorage();
    const coordinator = createAuthBoundaryDraftCoordinator({
      clock: () => 1_000,
      maxAgeMs: 60_000,
      storage,
      transport: {
        arm: vi.fn(() => Promise.resolve()),
        consume: () =>
          storage
            .save({
              expiresAt: 61_000,
              localRevision: 2,
              section: section("newer tab edit"),
            })
            .then(() => ({
              jobRequestId: "97000000-0000-4000-8000-000000000099",
              revision: 1,
            })),
      },
    });
    await coordinator.saveBeforeAuthentication(section("older"), csrf);

    await expect(
      coordinator.restoreAfterAuthentication(csrf),
    ).resolves.toMatchObject({
      clearedLocalDraft: false,
      status: "RESTORED",
    });
    await expect(storage.load()).resolves.toMatchObject({
      localRevision: 2,
      section: { payload: { description: "newer tab edit" } },
    });
  });

  it("expires locally without sending content", async () => {
    const storage = memoryStorage({
      expiresAt: 999,
      localRevision: 1,
      section: section("expired"),
    });
    const consume = vi.fn();
    const coordinator = createAuthBoundaryDraftCoordinator({
      clock: () => 1_000,
      maxAgeMs: 60_000,
      storage,
      transport: { arm: vi.fn(), consume },
    });

    await expect(coordinator.restoreAfterAuthentication(csrf)).resolves.toEqual(
      {
        status: "NO_LOCAL_DRAFT",
      },
    );
    expect(consume).not.toHaveBeenCalled();
    await expect(storage.load()).resolves.toBeNull();
  });
});

function section(description: string) {
  return {
    key: "request.core",
    payload: { description },
    schemaVersion: 1,
  } as const;
}

function memoryStorage(
  initial: LocalAuthBoundaryDraft | null = null,
): AuthBoundaryDraftStorage {
  let value = initial;
  return {
    clearIfRevision(localRevision) {
      if (value?.localRevision !== localRevision) return Promise.resolve(false);
      value = null;
      return Promise.resolve(true);
    },
    load: () => Promise.resolve(value),
    save(draft) {
      value = draft;
      return Promise.resolve();
    },
  };
}

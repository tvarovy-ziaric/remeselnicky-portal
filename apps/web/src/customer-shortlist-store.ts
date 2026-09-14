export type CustomerShortlistSnapshot = Readonly<
  | { readonly status: "LOADING" | "AUTH_REQUIRED" | "UNAVAILABLE" }
  | {
      readonly csrfToken: string;
      readonly pendingProfileIds: ReadonlySet<string>;
      readonly savedProfileIds: ReadonlySet<string>;
      readonly status: "READY";
    }
>;

export interface CustomerShortlistStore {
  getSnapshot(): CustomerShortlistSnapshot;
  load(signal?: AbortSignal): Promise<void>;
  subscribe(listener: () => void): () => void;
  toggle(profileId: string): Promise<void>;
}

export function createCustomerShortlistStore(
  input: {
    readonly commandId?: () => string;
    readonly fetch?: typeof fetch;
  } = {},
): CustomerShortlistStore {
  const fetcher = input.fetch ?? fetch;
  const commandId = input.commandId ?? (() => crypto.randomUUID());
  const listeners = new Set<() => void>();
  let snapshot: CustomerShortlistSnapshot = Object.freeze({
    status: "LOADING",
  });
  let loadPromise: Promise<void> | null = null;

  function publish(next: CustomerShortlistSnapshot): void {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  const store: CustomerShortlistStore = {
    getSnapshot: () => snapshot,
    load(signal?: AbortSignal) {
      loadPromise ??= load(fetcher, signal).then(publish);
      return loadPromise;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async toggle(profileId: string) {
      const current = snapshot;
      if (
        current.status !== "READY" ||
        current.pendingProfileIds.has(profileId)
      )
        return;
      const saved = current.savedProfileIds.has(profileId);
      publish(
        readySnapshot(
          current,
          current.savedProfileIds,
          new Set([...current.pendingProfileIds, profileId]),
        ),
      );
      const ok = await mutate(
        fetcher,
        commandId(),
        profileId,
        current.csrfToken,
        saved ? "remove" : "add",
      );
      if (!ok) {
        publish(Object.freeze({ status: "UNAVAILABLE" }));
        return;
      }
      const latest = snapshot;
      if (latest.status !== "READY") return;
      const savedProfileIds = new Set(latest.savedProfileIds);
      if (saved) savedProfileIds.delete(profileId);
      else savedProfileIds.add(profileId);
      const pendingProfileIds = new Set(latest.pendingProfileIds);
      pendingProfileIds.delete(profileId);
      publish(readySnapshot(latest, savedProfileIds, pendingProfileIds));
    },
  };
  return Object.freeze(store);
}

async function load(
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CustomerShortlistSnapshot> {
  try {
    const requestOptions: RequestInit = {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    };
    const session = await fetcher("/v1/auth/session", requestOptions);
    if (session.status === 401)
      return Object.freeze({ status: "AUTH_REQUIRED" });
    if (!session.ok) return Object.freeze({ status: "UNAVAILABLE" });
    const sessionBody = (await session.json()) as {
      readonly csrfToken?: unknown;
    };
    if (typeof sessionBody.csrfToken !== "string")
      return Object.freeze({ status: "UNAVAILABLE" });
    const shortlist = await fetcher("/v1/me/shortlist", requestOptions);
    if (!shortlist.ok) return Object.freeze({ status: "UNAVAILABLE" });
    const body = (await shortlist.json()) as { readonly items?: unknown };
    if (!Array.isArray(body.items))
      return Object.freeze({ status: "UNAVAILABLE" });
    const savedProfileIds = new Set<string>();
    for (const item of body.items) {
      if (!isShortlistItem(item))
        return Object.freeze({ status: "UNAVAILABLE" });
      savedProfileIds.add(item.craftsmanProfileId);
    }
    return readySnapshot(
      { csrfToken: sessionBody.csrfToken },
      savedProfileIds,
      new Set(),
    );
  } catch {
    return Object.freeze({ status: "UNAVAILABLE" });
  }
}

function readySnapshot(
  source: { readonly csrfToken: string },
  savedProfileIds: ReadonlySet<string>,
  pendingProfileIds: ReadonlySet<string>,
): CustomerShortlistSnapshot {
  return Object.freeze({
    csrfToken: source.csrfToken,
    pendingProfileIds: new Set(pendingProfileIds),
    savedProfileIds: new Set(savedProfileIds),
    status: "READY",
  });
}

function isShortlistItem(
  value: unknown,
): value is { readonly craftsmanProfileId: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["craftsmanProfileId"] === "string";
}

async function mutate(
  fetcher: typeof fetch,
  commandId: string,
  profileId: string,
  csrfToken: string,
  kind: "add" | "remove",
): Promise<boolean> {
  try {
    const response = await fetcher(`/v1/me/shortlist/${kind}`, {
      body: JSON.stringify({ commandId, craftsmanProfileId: profileId }),
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
      },
      method: "POST",
    });
    return response.status === 204;
  } catch {
    return false;
  }
}

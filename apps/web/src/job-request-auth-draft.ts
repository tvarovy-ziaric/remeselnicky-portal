"use client";

import { AUTH_API_PATHS } from "@portal/contracts";
import {
  normalizeJobRequestDraftSection,
  type JobRequestDraftSectionInput,
  type PersistAutosaveJobRequestDraftInput,
} from "@portal/domain";

export interface LocalAuthBoundaryDraft {
  readonly expiresAt: number;
  readonly localRevision: number;
  readonly section: JobRequestDraftSectionInput;
}

export interface AuthBoundaryDraftStorage {
  clearIfRevision(localRevision: number): Promise<boolean>;
  load(): Promise<LocalAuthBoundaryDraft | null>;
  save(draft: LocalAuthBoundaryDraft): Promise<void>;
}

export interface AuthBoundaryDraftTransport {
  arm(csrfToken: string): Promise<void>;
  consume(
    csrfToken: string,
    section: JobRequestDraftSectionInput,
  ): Promise<{ readonly jobRequestId: string; readonly revision: number }>;
}

export interface AuthBoundaryDraftCoordinator {
  restoreAfterAuthentication(csrfToken: string): Promise<
    | {
        readonly clearedLocalDraft: boolean;
        readonly jobRequestId: string;
        readonly revision: number;
        readonly status: "RESTORED";
      }
    | { readonly status: "NO_LOCAL_DRAFT" }
  >;
  saveBeforeAuthentication(
    section: JobRequestDraftSectionInput,
    csrfToken: string,
  ): Promise<{ readonly localRevision: number }>;
}

export function createAuthBoundaryDraftCoordinator(input: {
  readonly clock?: () => number;
  readonly maxAgeMs: number;
  readonly storage: AuthBoundaryDraftStorage;
  readonly transport: AuthBoundaryDraftTransport;
}): AuthBoundaryDraftCoordinator {
  if (!Number.isSafeInteger(input.maxAgeMs) || input.maxAgeMs < 60_000) {
    throw new TypeError("Auth-boundary draft maxAgeMs is invalid.");
  }
  const clock = input.clock ?? Date.now;
  return Object.freeze({
    async restoreAfterAuthentication(csrfToken: string) {
      assertCsrfToken(csrfToken);
      const local = await input.storage.load();
      if (local === null || local.expiresAt <= clock()) {
        if (local !== null)
          await input.storage.clearIfRevision(local.localRevision);
        return Object.freeze({ status: "NO_LOCAL_DRAFT" as const });
      }
      const section = outwardSection(local.section);
      const restored = await input.transport.consume(csrfToken, section);
      const clearedLocalDraft = await input.storage.clearIfRevision(
        local.localRevision,
      );
      return Object.freeze({
        clearedLocalDraft,
        jobRequestId: assertUuid(restored.jobRequestId),
        revision: assertPositiveInteger(restored.revision),
        status: "RESTORED" as const,
      });
    },

    async saveBeforeAuthentication(
      section: JobRequestDraftSectionInput,
      csrfToken: string,
    ) {
      assertCsrfToken(csrfToken);
      const normalized = outwardSection(section);
      const existing = await input.storage.load();
      const localRevision = (existing?.localRevision ?? 0) + 1;
      await input.storage.save(
        Object.freeze({
          expiresAt: clock() + input.maxAgeMs,
          localRevision,
          section: normalized,
        }),
      );
      await input.transport.arm(csrfToken);
      return Object.freeze({ localRevision });
    },
  });
}

export function createFetchAuthBoundaryDraftTransport(input: {
  readonly apiOrigin: string;
  readonly fetcher?: typeof fetch;
}): AuthBoundaryDraftTransport {
  const origin = new URL(input.apiOrigin);
  if (origin.protocol !== "https:" && origin.hostname !== "localhost") {
    throw new TypeError("Draft handoff API origin must use HTTPS.");
  }
  const fetcher = input.fetcher ?? fetch;
  const send = async (
    path: string,
    csrfToken: string,
    body?: Readonly<Record<string, unknown>>,
  ): Promise<Response> => {
    const response = await fetcher(new URL(path, origin), {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: "include",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "x-csrf-token": csrfToken,
      },
      method: "POST",
      referrerPolicy: "same-origin",
    });
    if (!response.ok) throw new Error("Draft handoff is unavailable.");
    return response;
  };
  const transport: AuthBoundaryDraftTransport = {
    async arm(csrfToken) {
      assertCsrfToken(csrfToken);
      await send(AUTH_API_PATHS.draftHandoffArm, csrfToken);
    },
    async consume(csrfToken, section) {
      assertCsrfToken(csrfToken);
      const response = await send(
        AUTH_API_PATHS.draftHandoffConsume,
        csrfToken,
        {
          section: outwardSection(section),
        },
      );
      const value: unknown = await response.json();
      if (!isRecord(value))
        throw new Error("Draft handoff response is invalid.");
      return Object.freeze({
        jobRequestId: assertUuid(value["jobRequestId"]),
        revision: assertPositiveInteger(value["revision"]),
      });
    },
  };
  return Object.freeze(transport);
}

export function createIndexedDbAuthBoundaryDraftStorage(
  input: {
    readonly indexedDb?: IDBFactory;
  } = {},
): AuthBoundaryDraftStorage {
  const factory = input.indexedDb ?? globalThis.indexedDB;
  if (factory === undefined) {
    throw new Error("IndexedDB is unavailable.");
  }
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const request = factory.open("portal-private-job-request-drafts", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("handoff")) {
          request.result.createObjectStore("handoff");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new Error("Draft storage is unavailable."));
    });
  const transact = async <T>(
    mode: IDBTransactionMode,
    operation: (
      store: IDBObjectStore,
      resolve: (value: T) => void,
      reject: (error: Error) => void,
    ) => void,
  ): Promise<T> => {
    const database = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = database.transaction("handoff", mode);
        let hasResult = false;
        let result: T;
        transaction.onerror = () =>
          reject(new Error("Draft storage transaction failed."));
        transaction.oncomplete = () => {
          if (hasResult) resolve(result);
          else
            reject(new Error("Draft storage transaction returned no result."));
        };
        operation(
          transaction.objectStore("handoff"),
          (value) => {
            result = value;
            hasResult = true;
          },
          reject,
        );
      });
    } finally {
      database.close();
    }
  };
  const storage: AuthBoundaryDraftStorage = {
    clearIfRevision(localRevision) {
      return transact<boolean>("readwrite", (store, resolve, reject) => {
        const read = store.get("current");
        read.onerror = () => reject(new Error("Draft storage read failed."));
        read.onsuccess = () => {
          const current = parseLocalDraft(read.result);
          if (current?.localRevision !== localRevision) {
            resolve(false);
            return;
          }
          const removal = store.delete("current");
          removal.onerror = () =>
            reject(new Error("Draft storage delete failed."));
          removal.onsuccess = () => resolve(true);
        };
      });
    },
    load() {
      return transact<LocalAuthBoundaryDraft | null>(
        "readonly",
        (store, resolve, reject) => {
          const request = store.get("current");
          request.onerror = () =>
            reject(new Error("Draft storage read failed."));
          request.onsuccess = () => resolve(parseLocalDraft(request.result));
        },
      );
    },
    save(draft) {
      const safe = parseLocalDraft(draft);
      if (safe === null) throw new TypeError("Local draft is invalid.");
      return transact<void>("readwrite", (store, resolve, reject) => {
        const request = store.put(safe, "current");
        request.onerror = () =>
          reject(new Error("Draft storage write failed."));
        request.onsuccess = () => resolve();
      });
    },
  };
  return Object.freeze(storage);
}

function parseLocalDraft(value: unknown): LocalAuthBoundaryDraft | null {
  if (!isRecord(value)) return null;
  try {
    const expiresAt = assertPositiveInteger(value["expiresAt"]);
    const localRevision = assertPositiveInteger(value["localRevision"]);
    const section = parseSection(value["section"]);
    return Object.freeze({ expiresAt, localRevision, section });
  } catch {
    return null;
  }
}

function parseSection(value: unknown): JobRequestDraftSectionInput {
  if (!isRecord(value)) throw new TypeError("Local draft section is invalid.");
  const key = value["key"];
  const schemaVersion = value["schemaVersion"];
  if (typeof key !== "string" || typeof schemaVersion !== "number") {
    throw new TypeError("Local draft section is invalid.");
  }
  return outwardSection({ key, payload: value["payload"], schemaVersion });
}

function outwardSection(
  value: JobRequestDraftSectionInput,
): JobRequestDraftSectionInput {
  const normalized: PersistAutosaveJobRequestDraftInput["section"] =
    normalizeJobRequestDraftSection(value);
  return Object.freeze({
    key: normalized.key,
    payload: normalized.payload,
    schemaVersion: normalized.schemaVersion,
  });
}

function assertCsrfToken(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 16 || value.length > 1024) {
    throw new TypeError("CSRF token is invalid.");
  }
}

function assertUuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new Error("Draft handoff response is invalid.");
  }
  return value;
}

function assertPositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error("Draft handoff numeric value is invalid.");
  }
  return Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

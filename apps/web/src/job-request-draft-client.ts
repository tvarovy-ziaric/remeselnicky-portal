import {
  normalizeJobRequestContentSection,
  type JobRequestContentSection,
  type JobRequestDraftSectionInput,
} from "@portal/domain";

export interface JobRequestEditableDraft {
  readonly id: string;
  readonly revision: number;
  readonly sections: readonly JobRequestContentSection[];
}

export type JobRequestDraftLoadResult = Readonly<
  | { readonly status: "AUTHENTICATION_REQUIRED" | "UNAVAILABLE" }
  | {
      readonly draft: JobRequestEditableDraft | null;
      readonly csrfToken: string;
      readonly status: "READY";
    }
>;

export type JobRequestDraftWriteResult = Readonly<
  | { readonly status: "UNAVAILABLE" }
  | { readonly currentRevision: number; readonly status: "STALE_REVISION" }
  | { readonly id: string; readonly revision: number; readonly status: "SAVED" }
>;

export type JobRequestActivationResult = Readonly<
  | { readonly status: "UNAVAILABLE" }
  | { readonly currentRevision: number; readonly status: "STALE_REVISION" }
  | {
      readonly missingRequirements: readonly string[];
      readonly status: "NOT_READY";
    }
  | {
      readonly id: string;
      readonly revision: number;
      readonly status: "ACTIVE";
    }
>;

export interface JobRequestMediaStatus {
  readonly assetId: string;
  readonly kind: "DOCUMENT" | "IMAGE";
  readonly status: "PROCESSING" | "READY" | "REJECTED";
}

export type JobRequestMediaListResult = Readonly<
  | { readonly status: "UNAVAILABLE" }
  | {
      readonly status: "OK";
      readonly uploads: readonly JobRequestMediaStatus[];
    }
>;

export type JobRequestMediaUploadResult = Readonly<
  | { readonly status: "UNAVAILABLE" }
  | {
      readonly asset: JobRequestMediaStatus;
      readonly status: "PROCESSING";
    }
>;

export interface JobRequestDraftClient {
  activate(
    draft: JobRequestEditableDraft,
    csrfToken: string,
  ): Promise<JobRequestActivationResult>;
  load(): Promise<JobRequestDraftLoadResult>;
  listMedia(draft: JobRequestEditableDraft): Promise<JobRequestMediaListResult>;
  save(
    draft: JobRequestEditableDraft | null,
    section: JobRequestDraftSectionInput,
    csrfToken: string,
  ): Promise<JobRequestDraftWriteResult>;
  uploadMedia(
    draft: JobRequestEditableDraft,
    file: Blob,
    kind: "DOCUMENT" | "IMAGE",
    csrfToken: string,
  ): Promise<JobRequestMediaUploadResult>;
}

export function createJobRequestDraftClient(
  input: {
    readonly commandId?: () => string;
    readonly fetch?: typeof fetch;
  } = {},
): JobRequestDraftClient {
  const fetcher = input.fetch ?? fetch;
  const commandId = input.commandId ?? (() => crypto.randomUUID());
  const pendingCommands = new Map<string, string>();
  const commandFor = (intent: string) => {
    const existing = pendingCommands.get(intent);
    if (existing !== undefined) return existing;
    const created = commandId();
    if (!uuid(created)) throw new TypeError("Command identifier is invalid.");
    pendingCommands.set(intent, created);
    return created;
  };
  const client: JobRequestDraftClient = {
    async activate(draft, csrfToken) {
      if (
        !uuid(draft.id) ||
        !positiveInteger(draft.revision) ||
        !csrf(csrfToken)
      ) {
        return Object.freeze({ status: "UNAVAILABLE" as const });
      }
      try {
        const intent = `activate:${draft.id}:${draft.revision}`;
        const response = await fetcher(
          `/v1/me/job-request-drafts/${draft.id}/activate`,
          writeOptions(csrfToken, {
            commandId: commandFor(intent),
            expectedRevision: draft.revision,
          }),
        );
        const body: unknown = await response.json();
        if (
          response.status === 409 &&
          record(body) &&
          body["code"] === "STALE_REVISION"
        ) {
          return positiveInteger(body["currentRevision"])
            ? Object.freeze({
                currentRevision: body["currentRevision"],
                status: "STALE_REVISION" as const,
              })
            : Object.freeze({ status: "UNAVAILABLE" as const });
        }
        if (
          response.status === 422 &&
          record(body) &&
          body["code"] === "NOT_READY"
        ) {
          return stringArray(body["missingRequirements"])
            ? Object.freeze({
                missingRequirements: body["missingRequirements"],
                status: "NOT_READY" as const,
              })
            : Object.freeze({ status: "UNAVAILABLE" as const });
        }
        if (
          !response.ok ||
          !record(body) ||
          !["APPLIED", "DEDUPLICATED"].includes(String(body["status"])) ||
          !uuid(body["id"]) ||
          !positiveInteger(body["revision"])
        ) {
          return Object.freeze({ status: "UNAVAILABLE" as const });
        }
        pendingCommands.delete(intent);
        return Object.freeze({
          id: body["id"],
          revision: body["revision"],
          status: "ACTIVE" as const,
        });
      } catch {
        return Object.freeze({ status: "UNAVAILABLE" as const });
      }
    },
    async load() {
      const options: RequestInit = {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      };
      try {
        const session = await fetcher("/v1/auth/session", options);
        if (session.status === 401)
          return Object.freeze({ status: "AUTHENTICATION_REQUIRED" as const });
        const sessionBody: unknown = await session.json();
        if (
          !session.ok ||
          !record(sessionBody) ||
          !csrf(sessionBody["csrfToken"])
        ) {
          return Object.freeze({ status: "UNAVAILABLE" as const });
        }
        const collection = await fetcher("/v1/me/job-request-drafts", options);
        const collectionBody: unknown = await collection.json();
        if (
          !collection.ok ||
          !record(collectionBody) ||
          !Array.isArray(collectionBody["drafts"])
        ) {
          return Object.freeze({ status: "UNAVAILABLE" as const });
        }
        const draftReferences = collectionBody["drafts"] as unknown[];
        if (draftReferences.length === 0) {
          return Object.freeze({
            csrfToken: sessionBody["csrfToken"],
            draft: null,
            status: "READY" as const,
          });
        }
        const first = draftReferences[0];
        if (!record(first) || !uuid(first["id"]))
          return Object.freeze({ status: "UNAVAILABLE" as const });
        const recovered = await fetcher(
          `/v1/me/job-request-drafts/${first["id"]}`,
          options,
        );
        const recoveredBody: unknown = await recovered.json();
        const draft = parseRecoveredDraft(recoveredBody);
        return recovered.ok && draft !== null
          ? Object.freeze({
              csrfToken: sessionBody["csrfToken"],
              draft,
              status: "READY" as const,
            })
          : Object.freeze({ status: "UNAVAILABLE" as const });
      } catch {
        return Object.freeze({ status: "UNAVAILABLE" as const });
      }
    },
    async listMedia(draft) {
      if (!uuid(draft.id))
        return Object.freeze({ status: "UNAVAILABLE" as const });
      try {
        const response = await fetcher(
          `/v1/me/job-request-drafts/${draft.id}/media`,
          {
            cache: "no-store",
            credentials: "same-origin",
            headers: { accept: "application/json" },
          },
        );
        const body: unknown = await response.json();
        if (!response.ok || !record(body) || !Array.isArray(body["uploads"])) {
          return Object.freeze({ status: "UNAVAILABLE" as const });
        }
        const uploads = body["uploads"];
        if (uploads.length > 138) {
          return Object.freeze({ status: "UNAVAILABLE" as const });
        }
        const parsed = uploads.map(parseMediaStatus);
        if (parsed.some((item) => item === null)) {
          return Object.freeze({ status: "UNAVAILABLE" as const });
        }
        return Object.freeze({
          status: "OK" as const,
          uploads: Object.freeze(parsed as JobRequestMediaStatus[]),
        });
      } catch {
        return Object.freeze({ status: "UNAVAILABLE" as const });
      }
    },
    async save(draft, section, csrfToken) {
      if (!csrf(csrfToken))
        return Object.freeze({ status: "UNAVAILABLE" as const });
      let normalized: JobRequestContentSection;
      try {
        normalized = normalizeJobRequestContentSection(section);
      } catch {
        return Object.freeze({ status: "UNAVAILABLE" as const });
      }
      const isCreate = draft === null;
      if (isCreate && normalized.key !== "request.core") {
        return Object.freeze({ status: "UNAVAILABLE" as const });
      }
      try {
        const intent = `save:${draft?.id ?? "new"}:${draft?.revision ?? 0}:${normalized.key}:${normalized.canonicalPayload}`;
        const response = await fetcher(
          isCreate
            ? "/v1/me/job-request-drafts"
            : `/v1/me/job-request-drafts/${draft.id}/sections`,
          writeOptions(csrfToken, {
            commandId: commandFor(intent),
            ...(isCreate ? {} : { expectedRevision: draft.revision }),
            section: {
              key: normalized.key,
              payload: normalized.payload,
              schemaVersion: normalized.schemaVersion,
            },
          }),
        );
        const body: unknown = await response.json();
        if (
          response.status === 409 &&
          record(body) &&
          body["code"] === "STALE_REVISION"
        ) {
          return positiveInteger(body["currentRevision"])
            ? Object.freeze({
                currentRevision: body["currentRevision"],
                status: "STALE_REVISION" as const,
              })
            : Object.freeze({ status: "UNAVAILABLE" as const });
        }
        if (
          !response.ok ||
          !record(body) ||
          !uuid(body["id"]) ||
          !positiveInteger(body["revision"]) ||
          !["APPLIED", "UNCHANGED", "DEDUPLICATED"].includes(
            String(body["status"]),
          )
        ) {
          return Object.freeze({ status: "UNAVAILABLE" as const });
        }
        pendingCommands.delete(intent);
        return Object.freeze({
          id: body["id"],
          revision: body["revision"],
          status: "SAVED" as const,
        });
      } catch {
        return Object.freeze({ status: "UNAVAILABLE" as const });
      }
    },
    async uploadMedia(draft, file, kind, csrfToken) {
      if (
        !uuid(draft.id) ||
        !positiveInteger(draft.revision) ||
        !csrf(csrfToken) ||
        !(file instanceof Blob) ||
        !validMediaContentType(file.type, kind)
      ) {
        return Object.freeze({ status: "UNAVAILABLE" as const });
      }
      try {
        const response = await fetcher(
          `/v1/me/job-request-drafts/${draft.id}/media/${kind === "IMAGE" ? "photos" : "documents"}`,
          {
            body: file,
            cache: "no-store",
            credentials: "same-origin",
            headers: {
              accept: "application/json",
              "content-type": file.type,
              "x-csrf-token": csrfToken,
              "x-job-request-revision": String(draft.revision),
            },
            method: "POST",
          },
        );
        const body: unknown = await response.json();
        const asset = parseMediaStatus(body);
        if (
          response.status !== 202 ||
          asset === null ||
          asset.status !== "PROCESSING" ||
          asset.kind !== kind
        ) {
          return Object.freeze({ status: "UNAVAILABLE" as const });
        }
        return Object.freeze({ asset, status: "PROCESSING" as const });
      } catch {
        return Object.freeze({ status: "UNAVAILABLE" as const });
      }
    },
  };
  return Object.freeze(client);
}

function parseRecoveredDraft(value: unknown): JobRequestEditableDraft | null {
  if (!record(value) || !record(value["draft"])) return null;
  const draft = value["draft"];
  if (
    !uuid(draft["id"]) ||
    !positiveInteger(draft["revision"]) ||
    !Array.isArray(draft["sections"]) ||
    draft["sections"].length > 64
  )
    return null;
  try {
    const sections = draft["sections"].map((section) => {
      if (
        !record(section) ||
        typeof section["key"] !== "string" ||
        typeof section["schemaVersion"] !== "number"
      )
        throw new TypeError("Invalid section");
      return normalizeJobRequestContentSection({
        key: section["key"],
        payload: section["payload"],
        schemaVersion: section["schemaVersion"],
      });
    });
    return Object.freeze({
      id: draft["id"],
      revision: draft["revision"],
      sections: Object.freeze(sections),
    });
  } catch {
    return null;
  }
}

function writeOptions(
  csrfToken: string,
  body: Readonly<Record<string, unknown>>,
): RequestInit {
  return {
    body: JSON.stringify(body),
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    },
    method: "POST",
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}
function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}
function csrf(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 1024;
}
function stringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= 16 &&
    value.every((item) => typeof item === "string" && item.length <= 64)
  );
}

function parseMediaStatus(value: unknown): JobRequestMediaStatus | null {
  if (
    !record(value) ||
    !uuid(value["assetId"]) ||
    !["DOCUMENT", "IMAGE"].includes(String(value["kind"])) ||
    !["PROCESSING", "READY", "REJECTED"].includes(String(value["status"]))
  ) {
    return null;
  }
  return Object.freeze({
    assetId: value["assetId"],
    kind: value["kind"] as "DOCUMENT" | "IMAGE",
    status: value["status"] as "PROCESSING" | "READY" | "REJECTED",
  });
}

function validMediaContentType(
  contentType: string,
  kind: "DOCUMENT" | "IMAGE",
): boolean {
  return kind === "DOCUMENT"
    ? contentType === "application/pdf"
    : ["image/heic", "image/heif", "image/jpeg", "image/png"].includes(
        contentType,
      );
}

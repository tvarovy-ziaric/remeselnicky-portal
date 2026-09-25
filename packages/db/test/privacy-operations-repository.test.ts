import type { PrivilegedActor } from "@portal/admin-auth";
import type { UserId } from "@portal/domain";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  createPrivacyOperationsRepository,
  type ExecuteAccountClosureInput,
  type TransitionPrivacyRequestInput,
} from "../src/index.js";

const actorUserId = "10000000-0000-4000-8000-000000000001" as UserId;
const subjectUserId = "20000000-0000-4000-8000-000000000002" as UserId;
const caseId = "30000000-0000-4000-8000-000000000003";
const commandId = "40000000-0000-4000-8000-000000000004";
const now = new Date("2026-09-25T00:00:00.000Z");

function fakeSql(responses: unknown[]) {
  const calls: TemplateStringsArray[] = [];
  const transaction = Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      void values;
      calls.push(strings);
      return Promise.resolve(responses.shift() ?? []);
    }),
    { json: vi.fn((value: unknown) => value) },
  );
  const begin = vi.fn((operation: (sql: unknown) => unknown) =>
    operation(transaction),
  );
  const root = Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      void values;
      calls.push(strings);
      return Promise.resolve(responses.shift() ?? []);
    }),
    { begin, json: transaction.json },
  );
  return { begin, calls, sql: root as unknown as Sql, transaction };
}

function actor(capability = true): PrivilegedActor {
  return {
    capabilities: new Set(
      capability ? (["admin.privacy.manage"] as const) : [],
    ),
    mfaAuthenticatedAt: now,
    roles: ["ADMIN"],
    userId: actorUserId,
  };
}

function closure(
  overrides: Partial<ExecuteAccountClosureInput> = {},
): ExecuteAccountClosureInput {
  return {
    actor: actor(),
    caseId,
    commandId,
    expectedRequestRevision: 4,
    expectedRequestState: "IN_REVIEW",
    privilegedSessionId: "privileged-session-identity",
    reason: "Overená žiadosť bez otvorených záväzkov.",
    reasonCode: "VERIFIED_ACCOUNT_CLOSURE",
    subjectUserId,
    ...overrides,
  };
}

function transition(
  overrides: Partial<TransitionPrivacyRequestInput> = {},
): TransitionPrivacyRequestInput {
  return {
    actionCode: "IDENTITY_VERIFIED",
    actor: actor(),
    caseId,
    commandId,
    deadlineAt: new Date("2026-10-25T00:00:00.000Z"),
    expectedRevision: 1,
    expectedState: "RECEIVED",
    privilegedSessionId: "privileged-session-identity",
    reason: "Identity and request scope were verified.",
    resultingState: "VERIFIED",
    ...overrides,
  };
}

describe("privacy operations repository", () => {
  it("lists only the authenticated subject's minimized request heads", async () => {
    const row = {
      actionCode: null,
      actorUserId: subjectUserId,
      caseId,
      deadlineAt: null,
      occurredAt: now,
      receivedAt: now,
      requestType: "ACCESS" as const,
      revision: 1,
      state: "RECEIVED" as const,
      subjectUserId,
    };
    const fixture = fakeSql([[row]]);
    await expect(
      createPrivacyOperationsRepository(fixture.sql).listForSubject({
        subjectUserId,
      }),
    ).resolves.toEqual([row]);
    expect(fixture.calls[0]?.join("?")).toMatch(/WHERE subject_user_id = \?/u);
  });

  it("exposes only the conservative open-obligation decision", async () => {
    const fixture = fakeSql([[{ blocked: true }]]);
    await expect(
      createPrivacyOperationsRepository(fixture.sql).hasOpenObligations(
        subjectUserId,
      ),
    ).resolves.toBe(true);
    expect(fixture.calls[0]?.join("?")).toContain(
      "privacy_account_has_open_obligations",
    );
  });

  it("lists the admin queue only after a recent MFA session check", async () => {
    const row = {
      actionCode: null,
      actorUserId: subjectUserId,
      caseId,
      deadlineAt: null,
      occurredAt: now,
      receivedAt: now,
      requestType: "ACCOUNT_CLOSURE" as const,
      revision: 1,
      state: "RECEIVED" as const,
      subjectUserId,
    };
    const fixture = fakeSql([[{ allowed: true }], [row]]);
    await expect(
      createPrivacyOperationsRepository(fixture.sql).listQueue({
        actor: actor(),
        limit: 25,
        privilegedSessionId: "privileged-session-identity",
        state: "RECEIVED",
      }),
    ).resolves.toEqual([row]);
    expect(fixture.calls[0]?.join("?")).toContain(
      "privacy_admin_session_is_recent",
    );
    expect(fixture.calls[1]?.join("?")).toContain(
      "FROM current_privacy_request_cases",
    );
  });

  it("appends an exact admin request transition and audit record", async () => {
    const inserted = {
      actorUserId,
      caseId,
      commandId,
      occurredAt: now,
      payloadFingerprint: "ignored-by-applied-path",
      revision: 2,
      state: "VERIFIED" as const,
    };
    const fixture = fakeSql([
      [],
      [],
      [{ revision: 1, state: "RECEIVED" }],
      [inserted],
      [],
    ]);
    await expect(
      createPrivacyOperationsRepository(fixture.sql).transitionRequest(
        transition(),
      ),
    ).resolves.toMatchObject({
      commandId,
      revision: 2,
      state: "VERIFIED",
      status: "APPLIED",
    });
    expect(
      fixture.calls.some((statement) =>
        statement.join("?").includes("privacy_request_admin_commands"),
      ),
    ).toBe(true);
    expect(
      fixture.calls.some((statement) =>
        statement.join("?").includes("INSERT INTO audit_events"),
      ),
    ).toBe(true);
  });

  it("requires the dedicated privacy capability before touching SQL", async () => {
    const fixture = fakeSql([]);
    await expect(
      createPrivacyOperationsRepository(fixture.sql).executeAccountClosure(
        closure({ actor: actor(false) }),
      ),
    ).rejects.toThrow(/capability/u);
    expect(fixture.begin).not.toHaveBeenCalled();
  });

  it("refuses deactivation while an active Job or dispute remains", async () => {
    const fixture = fakeSql([
      [],
      [],
      [],
      [
        {
          accountState: "ACTIVE",
          requestType: "ACCOUNT_CLOSURE",
          revision: 4,
          state: "IN_REVIEW",
          subjectUserId,
        },
      ],
      [{ blocked: true }],
    ]);
    await expect(
      createPrivacyOperationsRepository(fixture.sql).executeAccountClosure(
        closure(),
      ),
    ).resolves.toEqual({ status: "OPEN_OBLIGATIONS" });
    expect(
      fixture.calls.some((statement) =>
        statement
          .join("?")
          .includes("INSERT INTO privacy_account_closure_commands"),
      ),
    ).toBe(false);
  });

  it("deduplicates an exact command and returns category review state", async () => {
    const fingerprint = await import("node:crypto").then(({ createHash }) =>
      createHash("sha256")
        .update(
          JSON.stringify([
            caseId,
            subjectUserId,
            actorUserId,
            4,
            "IN_REVIEW",
            "VERIFIED_ACCOUNT_CLOSURE",
            "Overená žiadosť bez otvorených záväzkov.",
          ]),
          "utf8",
        )
        .digest("hex"),
    );
    const fixture = fakeSql([
      [],
      [
        {
          actorUserId,
          caseId,
          commandId,
          occurredAt: now,
          payloadFingerprint: fingerprint,
          requestRevision: 5,
          subjectUserId,
        },
      ],
      [
        {
          actionCode: "LEGAL_POLICY_REVIEW_REQUIRED",
          actorUserId,
          category: "ACCOUNT_CORE",
          disposition: "REVIEW_REQUIRED",
          occurredAt: now,
          policyVersionId: null,
          revision: 1,
          state: "BLOCKED",
        },
      ],
    ]);
    await expect(
      createPrivacyOperationsRepository(fixture.sql).executeAccountClosure(
        closure(),
      ),
    ).resolves.toMatchObject({
      dispositions: [
        { category: "ACCOUNT_CORE", disposition: "REVIEW_REQUIRED" },
      ],
      requestRevision: 5,
      requestState: "ACTION_REQUIRED",
      status: "DEDUPLICATED",
    });
  });
});

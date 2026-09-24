import { describe, expect, it, vi } from "vitest";

import {
  loadOwnerReviewResponse,
  submitModerationReport,
  submitOwnerReviewResponse,
} from "./review-response-report-data";

const reviewId = "b2000000-0000-4000-8000-000000000001";
const responseId = "b2000000-0000-4000-8000-000000000002";
const commandId = "b2000000-0000-4000-8000-000000000003";
const recordedAt = "2026-09-24T15:00:00.000Z";

describe("review response and report browser transport", () => {
  it("loads only the exact owner response and maps absence safely", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        responseId,
        reviewId,
        revisionId: commandId,
        version: 1,
        body: "Ďakujeme za vecnú spätnú väzbu.",
        respondedAt: recordedAt,
        revisedAt: recordedAt,
        editDeadline: "2026-09-24T16:00:00.000Z",
      }),
    );
    await expect(
      loadOwnerReviewResponse({ fetch: fetcher, reviewId }),
    ).resolves.toMatchObject({ status: "OK" });
    expect(fetcher).toHaveBeenCalledWith(
      `/v1/me/reviews/${reviewId}/response`,
      { cache: "no-store", credentials: "same-origin" },
    );

    fetcher.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(
      loadOwnerReviewResponse({ fetch: fetcher, reviewId }),
    ).resolves.toEqual({ status: "NONE" });
    fetcher.mockResolvedValueOnce(
      Response.json({
        responseId,
        reviewId,
        revisionId: commandId,
        version: 1,
        body: "Ďakujeme.",
        respondedAt: recordedAt,
        revisedAt: recordedAt,
        editDeadline: "2026-09-24T16:00:00.000Z",
        authorUserId: "private",
      }),
    );
    await expect(
      loadOwnerReviewResponse({ fetch: fetcher, reviewId }),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
  });

  it("submits a public-safe response with session CSRF and exact version intent", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-test" }))
      .mockResolvedValueOnce(
        Response.json(
          {
            status: "APPLIED",
            responseId,
            revisionId: commandId,
            version: 1,
            recordedAt,
          },
          { status: 201 },
        ),
      );
    await expect(
      submitOwnerReviewResponse({
        fetch: fetcher,
        reviewId,
        commandId,
        expectedVersion: 0,
        body: "Ďakujeme za vecnú spätnú väzbu.",
      }),
    ).resolves.toEqual({ status: "OK", version: 1 });
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      `/v1/me/reviews/${reviewId}/response`,
    );
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-csrf-token": "csrf-test",
      },
      body: JSON.stringify({
        body: "Ďakujeme za vecnú spätnú väzbu.",
        commandId,
        expectedVersion: 0,
      }),
    });
  });

  it("never sends contact details in a public response", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      submitOwnerReviewResponse({
        fetch: fetcher,
        reviewId,
        commandId,
        expectedVersion: 0,
        body: "Volajte +421 900 123 456",
      }),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("submits a report as an OPEN claim and never sends state or sanction", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-test" }))
      .mockResolvedValueOnce(
        Response.json(
          {
            status: "APPLIED",
            reportId: commandId,
            state: "OPEN",
            recordedAt,
          },
          { status: 201 },
        ),
      );
    await expect(
      submitModerationReport({
        fetch: fetcher,
        commandId,
        targetType: "MAIN_REVIEW",
        targetId: reviewId,
        reason: "IRRELEVANT_CONTENT",
        details: "Komentár nesúvisí so zákazkou.",
      }),
    ).resolves.toEqual({ status: "OK" });
    const requestBody = fetcher.mock.calls[1]?.[1]?.body;
    expect(typeof requestBody).toBe("string");
    if (typeof requestBody !== "string")
      throw new Error("Report request body missing.");
    const body = JSON.parse(requestBody) as Record<string, unknown>;
    expect(body).toEqual({
      commandId,
      targetType: "MAIN_REVIEW",
      targetId: reviewId,
      reason: "IRRELEVANT_CONTENT",
      details: "Komentár nesúvisí so zákazkou.",
    });
    expect(body).not.toHaveProperty("state");
    expect(body).not.toHaveProperty("sanction");
  });

  it("treats one reporter-target conflict as already reported", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-test" }))
      .mockResolvedValueOnce(
        Response.json({ code: "ALREADY_REPORTED" }, { status: 409 }),
      );
    await expect(
      submitModerationReport({
        fetch: fetcher,
        commandId,
        targetType: "REVIEW_RESPONSE",
        targetId: responseId,
        reason: "OTHER",
        details: "",
      }),
    ).resolves.toEqual({ status: "ALREADY_REPORTED" });
  });
});

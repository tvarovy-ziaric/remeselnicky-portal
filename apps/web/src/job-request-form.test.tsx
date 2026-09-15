import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { JobRequestDraftClient } from "./job-request-draft-client";
import {
  buildCraftsmanCandidateSearchHref,
  JobRequestForm,
} from "./job-request-form";

describe("JobRequestForm", () => {
  it("starts with a private recoverable loading state", () => {
    const client: JobRequestDraftClient = {
      activate: vi.fn(),
      load: vi.fn(),
      listMedia: vi.fn(),
      save: vi.fn(),
      uploadMedia: vi.fn(),
    };
    const html = renderToStaticMarkup(<JobRequestForm client={client} />);

    expect(html).toContain("Obnovujem váš dopyt");
    expect(html).toContain("Načítavam naposledy uloženú verziu");
    expect(html).not.toMatch(/csrf|customerProfileId|ownerUserId/iu);
  });

  it("builds an explicit request-scoped candidate selection link", () => {
    expect(
      buildCraftsmanCandidateSearchHref({
        jobRequestId: "9d300000-0000-4000-8000-000000000001",
        municipalityCode: "SK:BA:BA",
        professionCode: "PROF:TILER",
      }),
    ).toBe(
      "/remeselnici?jobRequestId=9d300000-0000-4000-8000-000000000001&professionCode=PROF%3ATILER&municipalityCode=SK%3ABA%3ABA",
    );
    expect(
      buildCraftsmanCandidateSearchHref({
        jobRequestId: "invalid",
        municipalityCode: "",
        professionCode: "PROF:TILER",
      }),
    ).toBeNull();
  });
});

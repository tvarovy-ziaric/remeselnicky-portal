import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { JobRequestDraftClient } from "./job-request-draft-client";
import { JobRequestForm } from "./job-request-form";

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
});

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { JobListView, loadJobList, parseJobList } from "./job-dashboard-list";

const jobId = "94000000-0000-4000-8000-000000000001";
const item = {
  id: jobId,
  state: "CONFIRMED",
  acceptedAt: "2026-09-16T10:00:00.000Z",
  role: "CUSTOMER",
  providerDisplayName: "Majster A",
  requestTitle: "Strecha",
};

describe("private Job list", () => {
  it("loads the owned-job endpoint without mutations", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ jobs: [item] })),
    );
    expect(await loadJobList(fetcher)).toMatchObject({
      status: "OK",
      jobs: [item],
    });
    expect(fetcher).toHaveBeenCalledWith("/v1/me/jobs", {
      cache: "no-store",
      credentials: "same-origin",
    });
  });

  it("fails closed on malformed rows and links only validated IDs", () => {
    expect(
      parseJobList({ jobs: [{ ...item, id: "javascript:alert(1)" }] }),
    ).toBeNull();
    expect(parseJobList({ jobs: [{ ...item, state: "DRAFT" }] })).toBeNull();
    expect(parseJobList({ jobs: [item, item] })).toBeNull();
    const jobs = parseJobList({ jobs: [item] });
    expect(jobs).not.toBeNull();
    if (!jobs) return;
    const html = renderToStaticMarkup(<JobListView jobs={jobs} />);
    expect(html).toContain(`/zakazky/${jobId}`);
    expect(html).toContain("Strecha");
    for (const [state, label] of [
      ["COMPLETION_REQUESTED", "Čaká na potvrdenie dokončenia"],
      ["COMPLETED", "Dokončená"],
    ] as const) {
      const completed = parseJobList({ jobs: [{ ...item, state }] });
      expect(completed).not.toBeNull();
      expect(renderToStaticMarkup(<JobListView jobs={completed!} />)).toContain(
        label,
      );
    }
  });
});

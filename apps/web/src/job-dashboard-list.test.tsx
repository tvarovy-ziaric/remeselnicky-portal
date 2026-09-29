import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  type JobListItem,
  JobListView,
  loadJobList,
  parseJobList,
} from "./job-dashboard-list";

const jobId = "94000000-0000-4000-8000-000000000001";
const item = {
  id: jobId,
  state: "CONFIRMED",
  acceptedAt: "2026-09-16T10:00:00.000Z",
  role: "CUSTOMER",
  providerDisplayName: "Majster A",
  requestTitle: "Strecha",
} satisfies JobListItem;

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
    expect(html).toContain("Otvoriť zákazku");
  });

  it("renders a safe empty state with the request CTA", () => {
    const html = renderToStaticMarkup(<JobListView jobs={[]} />);
    expect(html).toContain('class="empty-state"');
    expect(html).toContain("Zatiaľ nemáte potvrdenú zákazku");
    expect(html).toContain('href="/dopyt"');
    expect(html).toContain("Vytvoriť dopyt");
  });

  it("maps every status to human copy without leaking raw enums", () => {
    const states = [
      ["CONFIRMED", "Potvrdená"],
      ["IN_PROGRESS", "Práce prebiehajú"],
      ["COMPLETION_REQUESTED", "Čaká na potvrdenie dokončenia"],
      ["COMPLETED", "Dokončená"],
      ["CANCELLED", "Zrušená"],
    ] as const;
    const jobs = parseJobList({
      jobs: states.map(([state], index) => ({
        ...item,
        id: `94000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        state,
      })),
    });
    expect(jobs).not.toBeNull();
    const html = renderToStaticMarkup(<JobListView jobs={jobs!} />);
    for (const [state, label] of states) {
      expect(html).toContain(label);
      expect(html).not.toContain(state);
    }
  });

  it("shows a counterpart only when the DTO establishes one", () => {
    const customerMarkup = renderToStaticMarkup(<JobListView jobs={[item]} />);
    expect(customerMarkup).toContain("Hlavný poskytovateľ: Majster A");

    const providerMarkup = renderToStaticMarkup(
      <JobListView jobs={[{ ...item, role: "PRIMARY_PROVIDER" }]} />,
    );
    expect(providerMarkup).toContain("Vaša rola: hlavný poskytovateľ");
    expect(providerMarkup).not.toContain("Zákazník:");
    expect(providerMarkup).not.toContain("Hlavný poskytovateľ: Majster A");
  });
});

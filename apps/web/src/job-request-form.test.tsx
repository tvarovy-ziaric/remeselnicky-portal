import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { JobRequestDraftClient } from "./job-request-draft-client";
import {
  buildJobRequestReviewSummary,
  buildCraftsmanCandidateSearchHref,
  jobRequestAutosaveMessage,
  JobRequestForm,
  persistBeforeStepBack,
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
        serviceCode: "SERV:BATHROOM_TILING",
      }),
    ).toBe(
      "/remeselnici?jobRequestId=9d300000-0000-4000-8000-000000000001&professionCode=PROF%3ATILER&serviceCode=SERV%3ABATHROOM_TILING&municipalityCode=SK%3ABA%3ABA",
    );
    expect(
      buildCraftsmanCandidateSearchHref({
        jobRequestId: "invalid",
        municipalityCode: "",
        professionCode: "PROF:TILER",
      }),
    ).toBeNull();
  });

  it("persists the current section before moving back and stays put when saving fails", async () => {
    const order: string[] = [];
    let confirmSave: ((saved: boolean) => void) | undefined;
    const save = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          confirmSave = (saved) => {
            order.push("saved");
            resolve(saved);
          };
        }),
    );
    const move = vi.fn((step: number) => order.push(`moved:${step}`));

    const pending = persistBeforeStepBack({ currentStep: 3, move, save });
    expect(save).toHaveBeenCalledOnce();
    expect(move).not.toHaveBeenCalled();
    confirmSave?.(true);
    await expect(pending).resolves.toBe(true);
    expect(order).toEqual(["saved", "moved:2"]);

    await expect(
      persistBeforeStepBack({
        currentStep: 2,
        move,
        save: vi.fn().mockResolvedValue(false),
      }),
    ).resolves.toBe(false);
    expect(move).toHaveBeenCalledTimes(1);
    await expect(
      persistBeforeStepBack({
        currentStep: 0,
        move,
        save: vi.fn().mockResolvedValue(true),
      }),
    ).resolves.toBe(false);
    expect(move).toHaveBeenCalledTimes(1);
  });

  it("renders human review labels and never falls back to raw managed codes or enums", () => {
    const summary = buildJobRequestReviewSummary({
      attachmentCount: 3,
      budgetMode: "RANGE",
      description: "Opraviť strechu",
      municipalityCode: "TEST:MUNICIPALITY_ALPHA",
      municipalityLabel: "Bratislava",
      primaryProfessionCode: "PROF:ROOFER",
      primaryProfessionLabel: "Pokrývačské práce",
      timingMode: "AS_SOON_AS_POSSIBLE",
    });
    expect(summary).toEqual({
      attachments: "3 pripojených",
      budget: "Rozpätie",
      municipality: "Bratislava",
      profession: "Pokrývačské práce",
      timing: "Čo najskôr",
      work: "Opraviť strechu",
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /TEST:MUNICIPALITY_ALPHA|PROF:ROOFER|RANGE|AS_SOON_AS_POSSIBLE/u,
    );

    const restored = buildJobRequestReviewSummary({
      attachmentCount: 0,
      budgetMode: "UNRECOGNIZED_ENUM",
      description: "",
      municipalityCode: "TEST:MUNICIPALITY_ALPHA",
      municipalityLabel: "TEST:MUNICIPALITY_ALPHA",
      primaryProfessionCode: "PROF:ROOFER",
      primaryProfessionLabel: "",
      timingMode: "UNRECOGNIZED_ENUM",
    });
    expect(restored).toMatchObject({
      budget: "Neuvedené",
      municipality: "Vybraná obec",
      profession: "Vybraná spravovaná služba",
      timing: "Neuvedené",
    });
    expect(JSON.stringify(restored)).not.toMatch(
      /TEST:MUNICIPALITY_ALPHA|PROF:ROOFER|UNRECOGNIZED_ENUM/u,
    );
  });

  it("describes only confirmed autosave state and keeps pending edits explicit", () => {
    expect(
      jobRequestAutosaveMessage({
        dirty: false,
        hasDraft: false,
        lastConfirmedSaveAt: null,
        saving: false,
      }),
    ).toBe("Zmeny sa uložia automaticky po úprave.");
    expect(
      jobRequestAutosaveMessage({
        dirty: false,
        hasDraft: true,
        lastConfirmedSaveAt: null,
        saving: false,
      }),
    ).toBe("Uložený koncept bol obnovený.");
    expect(
      jobRequestAutosaveMessage({
        dirty: true,
        hasDraft: true,
        lastConfirmedSaveAt: null,
        saving: false,
      }),
    ).toBe("Zmeny ešte nie sú uložené.");
    expect(
      jobRequestAutosaveMessage({
        dirty: true,
        hasDraft: true,
        lastConfirmedSaveAt: Date.UTC(2026, 8, 29, 8, 30),
        saving: false,
      }),
    ).toMatch(/^Zmeny ešte nie sú uložené\. Posledné uloženie potvrdené o /u);
    expect(
      jobRequestAutosaveMessage({
        dirty: true,
        hasDraft: true,
        lastConfirmedSaveAt: null,
        saving: true,
      }),
    ).toBe("Ukladám zmeny…");
  });
});

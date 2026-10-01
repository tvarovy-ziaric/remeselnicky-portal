import { randomUUID } from "node:crypto";

import type {
  CraftsmanProfessionId,
  CraftsmanProfileId,
  CraftsmanServiceId,
  UserId,
} from "@portal/domain";
import { createTaxonomyAutocompleteService } from "@portal/search";
import { createTaxonomySuggestionService } from "@portal/taxonomy";
import type { Sql } from "postgres";
import { expect } from "vitest";

import {
  createCraftsmanProfessionRepository,
  createCraftsmanServiceRepository,
  createTaxonomyAutocompleteRepository,
  createTaxonomySuggestionRepository,
  ensureManagedCatalogV1,
} from "../src/index.js";

interface ProfileRow {
  readonly ownerUserId: UserId;
  readonly profileId: CraftsmanProfileId;
}

const managedProfessionCode = "PROF:ELECTRICIAN";
const managedServiceCode = "SERV:ELECTRICAL_INSTALLATION";

/**
 * End-of-suite assertions for the provisioned, public managed catalog. Keeping
 * these after the older fixture helpers also proves provisioning can safely
 * replace an arbitrary prior canonical release without mutating its history.
 */
export async function runManagedTaxonomyIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const installed = await ensureManagedCatalogV1(sql);
  const replay = await ensureManagedCatalogV1(sql);
  expect(replay).toEqual({ ...installed, activated: false });
  expect(installed.services).toBe(180);
  expect(installed.aliases).toBeGreaterThanOrEqual(450);

  const [catalogCounts] = await sql<
    Array<{
      readonly aliases: number;
      readonly professions: number;
      readonly services: number;
      readonly servicesWithoutOnePrimary: number;
    }>
  >`
    SELECT
      (SELECT count(*)::integer FROM taxonomy_professions
        WHERE release_id = ${installed.releaseId}
          AND profession_code <> 'PROF:ALPHA_SYNTHETIC') AS professions,
      (SELECT count(*)::integer FROM taxonomy_services
        WHERE release_id = ${installed.releaseId}) AS services,
      (SELECT count(*)::integer FROM taxonomy_aliases
        WHERE release_id = ${installed.releaseId}) AS aliases,
      (SELECT count(*)::integer FROM (
        SELECT service.service_code
        FROM taxonomy_services service
        LEFT JOIN taxonomy_service_professions link
          ON link.release_id = service.release_id
         AND link.service_code = service.service_code
         AND link.is_primary
        WHERE service.release_id = ${installed.releaseId}
        GROUP BY service.service_code
        HAVING count(link.profession_code) <> 1
      ) invalid) AS "servicesWithoutOnePrimary"
  `;
  expect(catalogCounts?.professions).toBe(45);
  expect(catalogCounts?.services).toBe(180);
  expect(catalogCounts?.servicesWithoutOnePrimary).toBe(0);
  expect(catalogCounts?.aliases ?? 0).toBeGreaterThanOrEqual(450);

  const autocomplete = createTaxonomyAutocompleteService(
    createTaxonomyAutocompleteRepository(sql),
  );
  const accentless = await autocomplete.autocomplete({
    query: "elektrikar",
    scope: "DISCOVERY",
  });
  expect(accentless.status).toBe("OK");
  if (accentless.status !== "OK")
    throw new Error("Expected autocomplete results.");
  const electrician = accentless.suggestions.find(
    ({ code }) => code === managedProfessionCode,
  );
  expect(electrician?.kind).toBe("PROFESSION");
  expect(electrician?.label).toBe("Elektrikár");
  expect(electrician?.routingProfessionCode).toBe(managedProfessionCode);

  const broadFirst = await autocomplete.autocomplete({
    limit: 10,
    query: "montaz",
    scope: "DISCOVERY",
  });
  const broadSecond = await autocomplete.autocomplete({
    limit: 10,
    query: "montaz",
    scope: "DISCOVERY",
  });
  expect(broadFirst).toEqual(broadSecond);
  expect(broadFirst.status).toBe("OK");
  if (broadFirst.status !== "OK")
    throw new Error("Expected broad autocomplete results.");
  expect(broadFirst.suggestions).toHaveLength(10);
  expect(
    new Set(broadFirst.suggestions.map(({ code, kind }) => `${kind}:${code}`))
      .size,
  ).toBe(10);
  expect(
    broadFirst.suggestions
      .filter((suggestion) => suggestion.kind === "SERVICE")
      .every(
        (suggestion) =>
          suggestion.routingProfessionCode !== undefined &&
          suggestion.professionCodes.includes(suggestion.routingProfessionCode),
      ),
  ).toBe(true);

  await assertMemberCountsAndCraftsmanServices(
    sql,
    installed.releaseId,
    autocomplete,
  );
  await assertSuggestionWorkflow(sql);
}

async function assertMemberCountsAndCraftsmanServices(
  sql: Sql,
  releaseId: string,
  autocomplete: ReturnType<typeof createTaxonomyAutocompleteService>,
): Promise<void> {
  const professionBefore = await exactCount(
    autocomplete,
    "Elektrikár",
    managedProfessionCode,
  );
  const serviceBefore = await exactCount(
    autocomplete,
    "Elektroinštalácia",
    managedServiceCode,
  );
  const [publicProfile] = await sql<ProfileRow[]>`
    SELECT searchable.craftsman_profile_id AS "profileId",
      profile.owner_user_id AS "ownerUserId"
    FROM current_searchable_craftsman_profiles searchable
    JOIN craftsman_profiles profile
      ON profile.id = searchable.craftsman_profile_id
    WHERE NOT EXISTS (
      SELECT 1 FROM current_moderation_user_restrictions restriction
      WHERE restriction.subject_user_id = profile.owner_user_id
        AND restriction.enforcement_scope IN ('ACCOUNT', 'PUBLISHING')
    )
      AND NOT EXISTS (
      SELECT 1 FROM current_craftsman_professions assignment
      WHERE assignment.craftsman_profile_id = profile.id
        AND assignment.profession_code = ${managedProfessionCode}
        AND assignment.state = 'ACTIVE'
    )
    ORDER BY searchable.craftsman_profile_id
    LIMIT 1
  `;
  if (publicProfile === undefined) {
    throw new Error(
      "Expected an earlier public-profile fixture for managed taxonomy counts.",
    );
  }

  const [hiddenOwner] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (hiddenOwner === undefined)
    throw new Error("Expected hidden fixture owner.");
  const [hiddenProfile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type)
    VALUES (${hiddenOwner.id}, 'INDIVIDUAL') RETURNING id
  `;
  if (hiddenProfile === undefined)
    throw new Error("Expected hidden fixture profile.");

  const publicAssignment = await assignProfession(sql, {
    ownerUserId: publicProfile.ownerUserId,
    profileId: publicProfile.profileId,
    releaseId,
  });
  const hiddenAssignment = await assignProfession(sql, {
    ownerUserId: hiddenOwner.id,
    profileId: hiddenProfile.id,
    releaseId,
  });
  const services = createCraftsmanServiceRepository(sql);
  const publicAdd = {
    actorUserId: publicProfile.ownerUserId,
    commandId: randomUUID(),
    craftsmanProfessionIds: [publicAssignment],
    craftsmanProfileId: publicProfile.profileId,
    craftsmanServiceId: randomUUID() as CraftsmanServiceId,
    serviceCode: managedServiceCode,
    taxonomyReleaseId: releaseId,
  } as const;
  const publicApplied = await services.add(publicAdd);
  expect(publicApplied.status).toBe("APPLIED");
  const publicReplay = await services.add(publicAdd);
  expect(publicReplay.status).toBe("DEDUPLICATED");
  await expect(
    services.listOwned({
      actorUserId: hiddenOwner.id,
      craftsmanProfileId: publicProfile.profileId,
    }),
  ).resolves.toEqual([]);

  await expect(
    services.add({
      actorUserId: hiddenOwner.id,
      commandId: randomUUID(),
      craftsmanProfessionIds: [publicAssignment],
      craftsmanProfileId: publicProfile.profileId,
      craftsmanServiceId: randomUUID() as CraftsmanServiceId,
      serviceCode: managedServiceCode,
      taxonomyReleaseId: releaseId,
    }),
  ).resolves.toEqual({ status: "PROFILE_UNAVAILABLE" });

  const hiddenApplied = await services.add({
    actorUserId: hiddenOwner.id,
    commandId: randomUUID(),
    craftsmanProfessionIds: [hiddenAssignment],
    craftsmanProfileId: hiddenProfile.id,
    craftsmanServiceId: randomUUID() as CraftsmanServiceId,
    serviceCode: managedServiceCode,
    taxonomyReleaseId: releaseId,
  });
  expect(hiddenApplied.status).toBe("APPLIED");

  expect(
    await exactCount(autocomplete, "Elektrikár", managedProfessionCode),
  ).toBe(professionBefore + 1);
  expect(
    await exactCount(autocomplete, "Elektroinštalácia", managedServiceCode),
  ).toBe(serviceBefore + 1);
}

async function assignProfession(
  sql: Sql,
  input: ProfileRow & { readonly releaseId: string },
): Promise<CraftsmanProfessionId> {
  const assignmentId = randomUUID() as CraftsmanProfessionId;
  const result = await createCraftsmanProfessionRepository(sql).assign({
    actorUserId: input.ownerUserId,
    commandId: randomUUID(),
    craftsmanProfessionId: assignmentId,
    craftsmanProfileId: input.profileId,
    declaredLevel: "ADVANCED",
    professionCode: managedProfessionCode,
    taxonomyReleaseId: input.releaseId,
  });
  expect(result.status).toBe("APPLIED");
  if (result.status !== "APPLIED") {
    throw new Error("Expected profession assignment.");
  }
  return assignmentId;
}

async function exactCount(
  autocomplete: ReturnType<typeof createTaxonomyAutocompleteService>,
  query: string,
  code: string,
): Promise<number> {
  const result = await autocomplete.autocomplete({ query, scope: "DISCOVERY" });
  if (result.status !== "OK") {
    throw new Error("Expected exact autocomplete result.");
  }
  const suggestion = result.suggestions.find(
    (candidate) => candidate.code === code,
  );
  if (suggestion === undefined) {
    throw new Error(`Expected taxonomy result ${code}.`);
  }
  return suggestion.memberCount;
}

async function assertSuggestionWorkflow(sql: Sql): Promise<void> {
  const [requester] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  const [admin] = await sql<{ readonly id: UserId }[]>`
    INSERT INTO users DEFAULT VALUES RETURNING id
  `;
  if (requester === undefined || admin === undefined) {
    throw new Error("Expected taxonomy workflow users.");
  }
  const [profile] = await sql<{ readonly id: CraftsmanProfileId }[]>`
    INSERT INTO craftsman_profiles (owner_user_id, profile_type)
    VALUES (${requester.id}, 'INDIVIDUAL') RETURNING id
  `;
  if (profile === undefined) {
    throw new Error("Expected taxonomy requester profile.");
  }
  await sql`
    INSERT INTO admin_role_grants (user_id, role, grant_source, reason)
    VALUES (${admin.id}, 'ADMIN', 'BOOTSTRAP',
      'Managed taxonomy integration workflow administrator')
  `;

  const repository = createTaxonomySuggestionRepository(sql);
  const service = createTaxonomySuggestionService({ persistence: repository });
  const submitted = await Promise.all([
    submitSuggestion(
      service,
      requester.id,
      profile.id,
      "Montáž inteligentnej elektrosteny",
    ),
    submitSuggestion(
      service,
      requester.id,
      profile.id,
      "Elektrina pre záhradný pavilón",
    ),
    submitSuggestion(
      service,
      requester.id,
      profile.id,
      "Historický skúšobný úkon",
    ),
  ]);
  const [approved, mapped, rejected] = submitted;
  if (
    approved === undefined ||
    mapped === undefined ||
    rejected === undefined
  ) {
    throw new Error("Expected three taxonomy suggestions.");
  }
  const pending = await repository.listPending(100);
  const pendingIds = new Set(
    pending.filter(({ state }) => state === "PENDING").map(({ id }) => id),
  );
  for (const { id } of submitted) expect(pendingIds.has(id)).toBe(true);
  const uniqueSuffix = randomUUID()
    .replaceAll("-", "")
    .slice(0, 12)
    .toUpperCase();
  const approveInput = {
    actorAdminUserId: admin.id,
    aliases: ["elektrostena na mieru"],
    canonicalCode: `SERV:INTEGRATION_${uniqueSuffix}`,
    canonicalDescription:
      "Riadená integračná služba pre overenie schvaľovania.",
    canonicalKind: "SERVICE" as const,
    canonicalName: "Montáž inteligentnej elektrosteny",
    commandId: randomUUID(),
    decision: "APPROVED_AS_NEW" as const,
    expectedRevision: 1,
    primaryProfessionCode: managedProfessionCode,
    professionCodes: [managedProfessionCode],
    suggestionId: approved.id,
  };
  const approveResult = await service.decide(approveInput);
  expect(approveResult.status).toBe("APPLIED");
  if (!("suggestion" in approveResult)) {
    throw new Error("Expected approved taxonomy suggestion.");
  }
  expect(approveResult.suggestion.state).toBe("APPROVED_AS_NEW");
  const approveReplay = await service.decide(approveInput);
  expect(approveReplay.status).toBe("DEDUPLICATED");
  const mapResult = await service.decide({
    actorAdminUserId: admin.id,
    addProposedNameAsAlias: false,
    adminDecisionNote: "Návrh zodpovedá existujúcej riadenej službe.",
    commandId: randomUUID(),
    decision: "MAPPED_TO_EXISTING",
    expectedRevision: 1,
    resolvedKind: "SERVICE",
    resolvedTaxonomyCode: managedServiceCode,
    suggestionId: mapped.id,
  });
  expect(mapResult.status).toBe("APPLIED");
  if (!("suggestion" in mapResult)) {
    throw new Error("Expected mapped taxonomy suggestion.");
  }
  expect(mapResult.suggestion.state).toBe("MAPPED_TO_EXISTING");
  const rejectResult = await service.decide({
    actorAdminUserId: admin.id,
    adminDecisionNote: "Návrh nie je samostatná profesia ani služba.",
    commandId: randomUUID(),
    decision: "REJECTED",
    expectedRevision: 1,
    suggestionId: rejected.id,
  });
  expect(rejectResult.status).toBe("APPLIED");
  if (!("suggestion" in rejectResult)) {
    throw new Error("Expected rejected taxonomy suggestion.");
  }
  expect(rejectResult.suggestion.state).toBe("REJECTED");

  await expect(sql`
    UPDATE taxonomy_suggestions SET proposed_name = 'Prepísaná história'
    WHERE suggestion_id = ${approved.id}
  `).rejects.toThrow(/append-only/u);
  await expect(sql`
    UPDATE taxonomy_suggestion_decisions SET admin_decision_note = 'Prepísaná história'
    WHERE suggestion_id = ${rejected.id}
  `).rejects.toThrow(/append-only/u);

  const events = await sql<
    Array<{ readonly eventName: string; readonly payload: unknown }>
  >`
    SELECT event_name AS "eventName", payload
    FROM domain_outbox_events
    WHERE entity_type = 'TAXONOMY_SUGGESTION'
      AND entity_id = ANY(${submitted.map(({ id }) => id)}::text[])
    ORDER BY event_name, entity_id, idempotency_key
  `;
  expect(events.length).toBeGreaterThanOrEqual(6);
  expect(
    events.some(
      ({ eventName }) => eventName === "taxonomy.suggestion.approved",
    ),
  ).toBe(true);
  expect(
    events.some(({ eventName }) => eventName === "taxonomy.suggestion.mapped"),
  ).toBe(true);
  expect(
    events.some(
      ({ eventName }) => eventName === "taxonomy.suggestion.rejected",
    ),
  ).toBe(true);
  const serializedEvents = JSON.stringify(events);
  for (const suggestion of submitted) {
    expect(serializedEvents).not.toContain(suggestion.proposedName);
    expect(serializedEvents).not.toContain(suggestion.proposedDescription);
  }
}

async function submitSuggestion(
  service: ReturnType<typeof createTaxonomySuggestionService>,
  actorUserId: UserId,
  requesterCraftsmanProfileId: CraftsmanProfileId,
  proposedName: string,
) {
  const input = {
    actorUserId,
    commandId: randomUUID(),
    proposedDescription:
      "Integračný návrh s dostatočným opisom potreby používateľa.",
    proposedName,
    requesterCraftsmanProfileId,
    suggestedKind: "SERVICE" as const,
    suggestionId: randomUUID(),
  };
  const applied = await service.submit(input);
  expect(applied.status).toBe("APPLIED");
  if (applied.status !== "APPLIED")
    throw new Error("Expected applied suggestion.");
  expect(applied.suggestion.state).toBe("PENDING");
  const replay = await service.submit(input);
  expect(replay.status).toBe("DEDUPLICATED");
  return applied.suggestion;
}

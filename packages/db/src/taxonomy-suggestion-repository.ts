import { createHash, randomUUID } from "node:crypto";

import type {
  DecideTaxonomySuggestionInput,
  SubmitTaxonomySuggestionInput,
  TaxonomySuggestion,
  TaxonomySuggestionPersistence,
  TaxonomySuggestionState,
} from "@portal/taxonomy";
import { TAXONOMY_SUGGESTION_LIMITS } from "@portal/taxonomy";
import type { Sql, TransactionSql } from "postgres";

interface SuggestionRow {
  readonly adminDecisionNote: string | null;
  readonly createdAt: Date;
  readonly decidedAt: Date | null;
  readonly decidedByAdminId: string | null;
  readonly id: string;
  readonly normalizedProposedName: string;
  readonly proposedDescription: string;
  readonly proposedName: string;
  readonly requesterCraftsmanProfileId: string;
  readonly requesterUserId: string;
  readonly resolvedTaxonomyCode: string | null;
  readonly resolvedTaxonomyLabel: string | null;
  readonly revision: number;
  readonly state: TaxonomySuggestionState;
  readonly suggestedKind: "PROFESSION" | "SERVICE" | null;
}

export interface TaxonomySuggestionReadRepository {
  findOwned(
    actorUserId: string,
    suggestionId: string,
  ): Promise<TaxonomySuggestion | null>;
  findForAdmin(suggestionId: string): Promise<TaxonomySuggestion | null>;
  listPending(limit: number): Promise<readonly TaxonomySuggestion[]>;
}

export type TaxonomyAdminCatalogKind = "PROFESSION" | "SERVICE";
export type TaxonomyAdminCatalogState = "ACTIVE" | "DEPRECATED";

export interface TaxonomyAdminCatalogItem {
  readonly aliases: readonly string[];
  readonly code: string;
  readonly description: string | null;
  readonly kind: TaxonomyAdminCatalogKind;
  readonly name: string;
  readonly primaryProfessionCode: string | null;
  readonly professionCodes: readonly string[];
  readonly releaseVersion: number;
  readonly replacedByCode: string | null;
  readonly slug: string;
  readonly state: TaxonomyAdminCatalogState;
}

export interface TaxonomyAdminAliasConflict {
  readonly alias: string;
  readonly conflictingCode: string;
  readonly conflictingKind: TaxonomyAdminCatalogKind;
  readonly conflictingName: string;
}

export interface TaxonomyAdminCatalogRepository {
  editItem(input: {
    readonly actorAdminUserId: string;
    readonly adminReason: string;
    readonly aliases: readonly string[];
    readonly canonicalCode: string;
    readonly commandId: string;
    readonly description: string | null;
    readonly expectedReleaseVersion: number;
    readonly kind: TaxonomyAdminCatalogKind;
    readonly name: string;
    readonly primaryProfessionCode: string | null;
    readonly professionCodes: readonly string[];
    readonly replacedByCode: string | null;
    readonly sourceTaxonomyCode: string;
    readonly state: TaxonomyAdminCatalogState;
  }): Promise<
    | {
        readonly aliasConflicts: readonly TaxonomyAdminAliasConflict[];
        readonly status: "ALIAS_CONFLICT";
      }
    | {
        readonly code:
          | "CANONICAL_CODE_CONFLICT"
          | "DEPENDENCIES_EXIST"
          | "ITEM_UNAVAILABLE"
          | "REPLACEMENT_UNAVAILABLE"
          | "STALE_RELEASE";
        readonly status: "CONFLICT";
      }
    | {
        readonly item: TaxonomyAdminCatalogItem;
        readonly status: "APPLIED" | "DEDUPLICATED";
      }
  >;
  findCatalogItem(
    taxonomyCode: string,
  ): Promise<TaxonomyAdminCatalogItem | null>;
  findSimilar(input: {
    readonly kind: TaxonomyAdminCatalogKind | null;
    readonly limit: number;
    readonly query: string;
  }): Promise<readonly TaxonomyAdminCatalogItem[]>;
  listCatalog(input: {
    readonly kind: TaxonomyAdminCatalogKind | null;
    readonly limit: number;
    readonly query: string | null;
    readonly state: TaxonomyAdminCatalogState | null;
  }): Promise<readonly TaxonomyAdminCatalogItem[]>;
}

export class TaxonomySuggestionIdempotencyError extends Error {
  readonly code = "TAXONOMY_SUGGESTION_IDEMPOTENCY_CONFLICT";
}

export function createTaxonomySuggestionRepository(
  sql: Sql,
): TaxonomySuggestionPersistence &
  TaxonomySuggestionReadRepository &
  TaxonomyAdminCatalogRepository {
  return Object.freeze({
    async submit(
      input: SubmitTaxonomySuggestionInput & {
        readonly normalizedProposedName: string;
      },
    ) {
      return sql.begin(async (transaction) => {
        const fingerprint = hash([
          input.commandId,
          input.suggestionId,
          input.actorUserId,
          input.requesterCraftsmanProfileId,
          input.proposedName,
          input.proposedDescription,
          input.suggestedKind,
        ]);
        const [replay] = await transaction<
          { fingerprint: string; id: string }[]
        >`
          SELECT suggestion_id AS id, submission_fingerprint AS fingerprint
          FROM taxonomy_suggestions WHERE submission_command_id = ${input.commandId}
        `;
        if (replay !== undefined) {
          if (
            replay.id !== input.suggestionId ||
            replay.fingerprint !== fingerprint
          ) {
            throw new TaxonomySuggestionIdempotencyError(
              "Suggestion command id was reused with different intent.",
            );
          }
          return {
            status: "DEDUPLICATED",
            suggestion: await mustGetSuggestion(transaction, replay.id),
          } as const;
        }
        const [owner] = await transaction<
          { accountState: string; ownerUserId: string }[]
        >`
          SELECT profile.owner_user_id AS "ownerUserId", owner.account_state AS "accountState"
          FROM craftsman_profiles profile JOIN users owner ON owner.id = profile.owner_user_id
          WHERE profile.id = ${input.requesterCraftsmanProfileId}
          FOR UPDATE OF profile, owner
        `;
        if (
          owner?.ownerUserId !== input.actorUserId ||
          owner?.accountState !== "ACTIVE"
        ) {
          return { status: "PROFILE_UNAVAILABLE" } as const;
        }
        const [pending] = await transaction<{ count: number }[]>`
          SELECT count(*)::integer AS count FROM current_taxonomy_suggestions
          WHERE requester_craftsman_profile_id = ${input.requesterCraftsmanProfileId}
            AND state = 'PENDING'
        `;
        if (
          (pending?.count ?? 0) >=
          TAXONOMY_SUGGESTION_LIMITS.pendingPerCraftsmanProfile
        ) {
          return { status: "PENDING_LIMIT_REACHED" } as const;
        }
        const [duplicate] = await transaction<{ id: string }[]>`
          SELECT id FROM current_taxonomy_suggestions
          WHERE requester_craftsman_profile_id = ${input.requesterCraftsmanProfileId}
            AND normalized_proposed_name = ${input.normalizedProposedName}
            AND state = 'PENDING' LIMIT 1
        `;
        if (duplicate !== undefined)
          return { status: "DUPLICATE_PENDING" } as const;
        await transaction`
          INSERT INTO taxonomy_suggestions (
            suggestion_id, requester_user_id, requester_craftsman_profile_id,
            proposed_name, proposed_description, normalized_proposed_name,
            suggested_kind, submission_command_id, submission_fingerprint
          ) VALUES (${input.suggestionId}, ${input.actorUserId},
            ${input.requesterCraftsmanProfileId}, ${input.proposedName},
            ${input.proposedDescription}, ${input.normalizedProposedName},
            ${input.suggestedKind ?? null}, ${input.commandId}, ${fingerprint})
        `;
        return {
          status: "APPLIED",
          suggestion: await mustGetSuggestion(transaction, input.suggestionId),
        } as const;
      });
    },

    async decide(input: DecideTaxonomySuggestionInput) {
      return sql.begin(async (transaction) => {
        const fingerprint = hash(decisionFingerprint(input));
        const [replay] = await transaction<
          { fingerprint: string; suggestionId: string }[]
        >`
          SELECT suggestion_id AS "suggestionId", command_fingerprint AS fingerprint
          FROM taxonomy_suggestion_decisions WHERE command_id = ${input.commandId}
        `;
        if (replay !== undefined) {
          if (
            replay.suggestionId !== input.suggestionId ||
            replay.fingerprint !== fingerprint
          ) {
            throw new TaxonomySuggestionIdempotencyError(
              "Decision command id was reused with different intent.",
            );
          }
          return {
            status: "DEDUPLICATED",
            suggestion: await mustGetSuggestion(
              transaction,
              input.suggestionId,
            ),
          } as const;
        }
        await transaction`SELECT suggestion_id FROM taxonomy_suggestions
          WHERE suggestion_id = ${input.suggestionId} FOR UPDATE`;
        const suggestion = await getSuggestion(transaction, input.suggestionId);
        if (suggestion === null)
          return { status: "SUGGESTION_UNAVAILABLE" } as const;
        if (suggestion.state !== "PENDING")
          return { status: "SUGGESTION_NOT_PENDING" } as const;
        if (suggestion.revision !== input.expectedRevision)
          return { status: "STALE_REVISION" } as const;
        const [admin] = await transaction<{ active: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM users admin_user JOIN admin_role_grants grant_row
              ON grant_row.user_id = admin_user.id AND grant_row.revoked_at IS NULL
            WHERE admin_user.id = ${input.actorAdminUserId}
              AND admin_user.account_state = 'ACTIVE'
              AND grant_row.role IN ('ADMIN', 'SUPER_ADMIN')
          ) AS active
        `;
        if (admin?.active !== true)
          return { status: "SUGGESTION_UNAVAILABLE" } as const;

        let resolvedCode: string | null = null;
        let resolvedKind: "PROFESSION" | "SERVICE" | null = null;
        let resolvedLabel: string | null = null;
        let resultingReleaseId: string | null = null;
        let addAlias = false;
        if (input.decision === "MAPPED_TO_EXISTING") {
          resolvedLabel = await targetLabel(
            transaction,
            input.resolvedKind,
            input.resolvedTaxonomyCode,
          );
          if (resolvedLabel === null) {
            return { status: "TAXONOMY_ITEM_UNAVAILABLE" } as const;
          }
          resolvedCode = input.resolvedTaxonomyCode;
          resolvedKind = input.resolvedKind;
          addAlias = input.addProposedNameAsAlias;
          if (addAlias) {
            if (
              await aliasValueConflicts(transaction, suggestion.proposedName)
            ) {
              return { status: "ALIAS_CONFLICT" } as const;
            }
            const release = await cloneCurrentRelease(
              transaction,
              input.commandId,
              input.actorAdminUserId,
            );
            resultingReleaseId = release.releaseId;
            await insertAlias(
              transaction,
              release.releaseId,
              suggestion.proposedName,
              resolvedKind,
              resolvedCode,
            );
            await activateRelease(transaction, release);
          }
        } else if (input.decision === "APPROVED_AS_NEW") {
          if (await targetCodeExists(transaction, input.canonicalCode)) {
            return { status: "CANONICAL_CODE_CONFLICT" } as const;
          }
          if (await anyAliasValueConflicts(transaction, input.aliases)) {
            return { status: "ALIAS_CONFLICT" } as const;
          }
          const release = await cloneCurrentRelease(
            transaction,
            input.commandId,
            input.actorAdminUserId,
          );
          resultingReleaseId = release.releaseId;
          resolvedCode = input.canonicalCode;
          resolvedKind = input.canonicalKind;
          resolvedLabel = input.canonicalName;
          const slug = slugify(input.canonicalName);
          if (input.canonicalKind === "PROFESSION") {
            await transaction`
              INSERT INTO taxonomy_professions (release_id, profession_code, slug,
                label_sk, description_sk, state, replaced_by_code)
              VALUES (${release.releaseId}, ${input.canonicalCode}, ${slug},
                ${input.canonicalName}, ${input.canonicalDescription}, 'ACTIVE', NULL)
            `;
          } else {
            const activeProfessions = await transaction<{ code: string }[]>`
              SELECT profession_code AS code FROM taxonomy_professions
              WHERE release_id = ${release.releaseId}
                AND profession_code = ANY(${input.professionCodes}) AND state = 'ACTIVE'
            `;
            if (activeProfessions.length !== input.professionCodes.length) {
              return { status: "TAXONOMY_ITEM_UNAVAILABLE" } as const;
            }
            await transaction`
              INSERT INTO taxonomy_services (release_id, service_code, slug,
                label_sk, description_sk, state, replaced_by_code)
              VALUES (${release.releaseId}, ${input.canonicalCode}, ${slug},
                ${input.canonicalName}, ${input.canonicalDescription}, 'ACTIVE', NULL)
            `;
            for (const professionCode of input.professionCodes) {
              await transaction`
                INSERT INTO taxonomy_service_professions (
                  release_id, service_code, profession_code, is_primary
                ) VALUES (${release.releaseId}, ${input.canonicalCode},
                  ${professionCode}, ${professionCode === input.primaryProfessionCode})
              `;
            }
          }
          for (const alias of input.aliases) {
            await insertAlias(
              transaction,
              release.releaseId,
              alias,
              resolvedKind,
              resolvedCode,
            );
          }
          await activateRelease(transaction, release);
        }

        await transaction`
          INSERT INTO taxonomy_suggestion_decisions (
            decision_id, suggestion_id, decision, decided_by_admin_id,
            admin_decision_note, resolved_taxonomy_kind, resolved_taxonomy_code,
            resolved_taxonomy_label, resulting_release_id,
            add_proposed_name_as_alias, command_id,
            command_fingerprint
          ) VALUES (${randomUUID()}, ${input.suggestionId}, ${input.decision},
            ${input.actorAdminUserId}, ${input.adminDecisionNote ?? null}, ${resolvedKind},
            ${resolvedCode}, ${resolvedLabel}, ${resultingReleaseId}, ${addAlias}, ${input.commandId},
            ${fingerprint})
        `;
        await transaction`
          INSERT INTO audit_events (event_id, correlation_id, category,
            actor_kind, actor_user_id, actor_capability, action_type,
            target_type, target_id, reason, changes)
          VALUES (${input.commandId}, ${input.commandId}, 'PRIVILEGED_COMMAND',
            'AUTHENTICATED_USER', ${input.actorAdminUserId}, 'admin.taxonomy.manage',
            ${`taxonomy.suggestion.${input.decision.toLowerCase()}`},
            'TAXONOMY_SUGGESTION', ${input.suggestionId},
            'Managed taxonomy suggestion decision.', '{}'::jsonb)
        `;
        return {
          status: "APPLIED",
          suggestion: await mustGetSuggestion(transaction, input.suggestionId),
        } as const;
      });
    },

    async findOwned(actorUserId: string, suggestionId: string) {
      const [row] = await sql.unsafe<SuggestionRow[]>(
        `${suggestionSelect} WHERE suggestion.id = $1 AND suggestion.requester_user_id = $2`,
        [suggestionId, actorUserId],
      );
      return row === undefined ? null : freeze(row);
    },
    async findForAdmin(suggestionId: string) {
      const [row] = await sql.unsafe<SuggestionRow[]>(
        `${suggestionSelect} WHERE suggestion.id = $1`,
        [suggestionId],
      );
      return row === undefined ? null : freeze(row);
    },
    async listPending(limit: number) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new TypeError("Invalid pending suggestion limit.");
      const rows = await sql.unsafe<SuggestionRow[]>(
        `${suggestionSelect} WHERE suggestion.state = 'PENDING' ORDER BY suggestion.created_at, suggestion.id LIMIT $1`,
        [limit],
      );
      return Object.freeze(rows.map(freeze));
    },

    async listCatalog(
      input: Parameters<TaxonomyAdminCatalogRepository["listCatalog"]>[0],
    ) {
      assertCatalogLimit(input.limit, 300);
      const query = normalizeCatalogQuery(input.query);
      const rows = await sql.unsafe<TaxonomyAdminCatalogItem[]>(
        `${catalogSelect}
         WHERE ($1::text IS NULL OR item.search_text ILIKE '%' || portal_taxonomy_normalize($1) || '%')
           AND ($2::text IS NULL OR item.kind = $2)
           AND ($3::text IS NULL OR item.state = $3)
         ORDER BY item.kind, item.name, item.code
         LIMIT $4`,
        [query, input.kind, input.state, input.limit],
      );
      return freezeCatalogRows(rows);
    },

    async findCatalogItem(taxonomyCode: string) {
      assertTaxonomyCode(taxonomyCode);
      const [row] = await sql.unsafe<TaxonomyAdminCatalogItem[]>(
        `${catalogSelect} WHERE item.code = $1`,
        [taxonomyCode],
      );
      return row === undefined ? null : freezeCatalogItem(row);
    },

    async findSimilar(
      input: Parameters<TaxonomyAdminCatalogRepository["findSimilar"]>[0],
    ) {
      assertCatalogLimit(input.limit, 20);
      const query = normalizeRequiredCatalogQuery(input.query);
      const rows = await sql.unsafe<TaxonomyAdminCatalogItem[]>(
        `${catalogSelect}
         WHERE ($2::text IS NULL OR item.kind = $2)
         ORDER BY greatest(
           similarity(item.search_text, portal_taxonomy_normalize($1)),
           similarity(portal_taxonomy_normalize(item.name), portal_taxonomy_normalize($1))
         ) DESC, item.kind, item.name, item.code
         LIMIT $3`,
        [query, input.kind, input.limit],
      );
      return freezeCatalogRows(rows);
    },

    async editItem(
      input: Parameters<TaxonomyAdminCatalogRepository["editItem"]>[0],
    ) {
      const normalized = normalizeCatalogEdit(input);
      return sql.begin(async (transaction) =>
        editCatalogItem(transaction, normalized),
      );
    },
  });
}

const catalogSelect = `WITH current_release AS (
    SELECT release.release_id, release.version
    FROM profession_taxonomy_activation_events activation
    JOIN profession_taxonomy_releases release
      ON release.release_id = activation.release_id
    ORDER BY activation.activation_sequence DESC
    LIMIT 1
  ), item AS (
    SELECT profession.profession_code AS code, 'PROFESSION'::text AS kind,
      profession.label_sk AS name, profession.description_sk AS description,
      profession.slug, profession.state::text AS state,
      profession.replaced_by_code AS "replacedByCode", current.version AS "releaseVersion",
      ARRAY[]::text[] AS "professionCodes",
      NULL::text AS "primaryProfessionCode",
      coalesce(alias_data.aliases, ARRAY[]::text[]) AS aliases,
      portal_taxonomy_normalize(profession.label_sk || ' ' ||
        coalesce(array_to_string(alias_data.aliases, ' '), '')) AS search_text
    FROM current_release current
    JOIN taxonomy_professions profession ON profession.release_id = current.release_id
    LEFT JOIN LATERAL (
      SELECT array_agg(alias.alias ORDER BY alias.alias) AS aliases
      FROM taxonomy_aliases alias
      WHERE alias.release_id = profession.release_id
        AND alias.target_kind = 'PROFESSION'
        AND alias.target_code = profession.profession_code
        AND alias.alias_kind = 'SEARCH_TERM'
    ) alias_data ON true
    UNION ALL
    SELECT service.service_code AS code, 'SERVICE'::text AS kind,
      service.label_sk AS name, service.description_sk AS description,
      service.slug, service.state::text AS state,
      service.replaced_by_code AS "replacedByCode", current.version AS "releaseVersion",
      links.profession_codes AS "professionCodes",
      links.primary_profession_code AS "primaryProfessionCode",
      coalesce(alias_data.aliases, ARRAY[]::text[]) AS aliases,
      portal_taxonomy_normalize(service.label_sk || ' ' ||
        coalesce(array_to_string(alias_data.aliases, ' '), '')) AS search_text
    FROM current_release current
    JOIN taxonomy_services service ON service.release_id = current.release_id
    JOIN LATERAL (
      SELECT array_agg(link.profession_code ORDER BY link.profession_code) AS profession_codes,
        max(link.profession_code) FILTER (WHERE link.is_primary) AS primary_profession_code
      FROM taxonomy_service_professions link
      WHERE link.release_id = service.release_id
        AND link.service_code = service.service_code
    ) links ON true
    LEFT JOIN LATERAL (
      SELECT array_agg(alias.alias ORDER BY alias.alias) AS aliases
      FROM taxonomy_aliases alias
      WHERE alias.release_id = service.release_id
        AND alias.target_kind = 'SERVICE'
        AND alias.target_code = service.service_code
        AND alias.alias_kind = 'SEARCH_TERM'
    ) alias_data ON true
  )
  SELECT item.aliases, item.code, item.description, item.kind, item.name,
    item."primaryProfessionCode", item."professionCodes", item."releaseVersion", item."replacedByCode",
    item.slug, item.state
  FROM item`;

interface NormalizedCatalogEdit {
  readonly actorAdminUserId: string;
  readonly adminReason: string;
  readonly aliases: readonly string[];
  readonly canonicalCode: string;
  readonly commandId: string;
  readonly description: string | null;
  readonly expectedReleaseVersion: number;
  readonly fingerprint: string;
  readonly kind: TaxonomyAdminCatalogKind;
  readonly name: string;
  readonly primaryProfessionCode: string | null;
  readonly professionCodes: readonly string[];
  readonly replacedByCode: string | null;
  readonly sourceTaxonomyCode: string;
  readonly state: TaxonomyAdminCatalogState;
}

function normalizeCatalogEdit(
  input: Parameters<TaxonomyAdminCatalogRepository["editItem"]>[0],
): NormalizedCatalogEdit {
  assertUuid(input.actorAdminUserId, "actorAdminUserId");
  assertUuid(input.commandId, "commandId");
  assertTaxonomyCode(input.sourceTaxonomyCode);
  assertTaxonomyCode(input.canonicalCode);
  if (
    !Number.isSafeInteger(input.expectedReleaseVersion) ||
    input.expectedReleaseVersion < 1
  ) {
    throw new TypeError("Invalid taxonomy release version.");
  }
  const kind = input.kind;
  const expectedPrefix = kind === "PROFESSION" ? "PROF:" : "SERV:";
  if (!input.canonicalCode.startsWith(expectedPrefix)) {
    throw new TypeError("Canonical code does not match taxonomy kind.");
  }
  const name = normalizeCatalogText(input.name, 2, 100, "name");
  const description =
    input.description === null
      ? null
      : normalizeCatalogText(input.description, 4, 500, "description");
  const adminReason = normalizeCatalogText(
    input.adminReason,
    8,
    500,
    "adminReason",
  );
  if (input.state !== "ACTIVE" && input.state !== "DEPRECATED") {
    throw new TypeError("Invalid taxonomy state.");
  }
  if (
    (input.state === "ACTIVE" && input.replacedByCode !== null) ||
    (input.state === "DEPRECATED" && input.replacedByCode === null)
  ) {
    throw new TypeError("Invalid taxonomy replacement lifecycle.");
  }
  if (input.replacedByCode !== null) {
    assertTaxonomyCode(input.replacedByCode);
    if (
      !input.replacedByCode.startsWith(expectedPrefix) ||
      input.replacedByCode === input.canonicalCode
    ) {
      throw new TypeError("Invalid replacement taxonomy code.");
    }
  }
  const aliasValues: unknown = input.aliases;
  if (!isStringArray(aliasValues) || aliasValues.length > 40) {
    throw new TypeError("Invalid taxonomy aliases.");
  }
  const seenAliases = new Set<string>();
  const aliases = aliasValues.map((value) => {
    const alias = normalizeCatalogText(value, 2, 100, "alias");
    const key = aliasSlug(alias);
    if (key === slugify(name) || seenAliases.has(key)) {
      throw new TypeError("Duplicate taxonomy alias.");
    }
    seenAliases.add(key);
    return alias;
  });
  const professionCodeValues: unknown = input.professionCodes;
  if (!isStringArray(professionCodeValues)) {
    throw new TypeError("Invalid service profession links.");
  }
  const professionCodes = [...professionCodeValues];
  if (
    new Set(professionCodes).size !== professionCodes.length ||
    professionCodes.some((value) => {
      try {
        assertTaxonomyCode(value);
        return !value.startsWith("PROF:");
      } catch {
        return true;
      }
    })
  ) {
    throw new TypeError("Invalid service profession links.");
  }
  if (kind === "PROFESSION") {
    if (professionCodes.length !== 0 || input.primaryProfessionCode !== null) {
      throw new TypeError("A profession cannot contain service routing links.");
    }
  } else if (
    professionCodes.length < 1 ||
    professionCodes.length > 8 ||
    input.primaryProfessionCode === null ||
    !professionCodes.includes(input.primaryProfessionCode)
  ) {
    throw new TypeError("A service requires an explicit primary profession.");
  }
  const normalized = {
    actorAdminUserId: input.actorAdminUserId,
    adminReason,
    aliases: Object.freeze(aliases),
    canonicalCode: input.canonicalCode,
    commandId: input.commandId,
    description,
    expectedReleaseVersion: input.expectedReleaseVersion,
    kind,
    name,
    primaryProfessionCode: input.primaryProfessionCode,
    professionCodes: Object.freeze(professionCodes.sort()),
    replacedByCode: input.replacedByCode,
    sourceTaxonomyCode: input.sourceTaxonomyCode,
    state: input.state,
  } as const;
  return Object.freeze({
    ...normalized,
    fingerprint: hash(normalized),
  });
}

async function editCatalogItem(
  sql: TransactionSql,
  input: NormalizedCatalogEdit,
): Promise<Awaited<ReturnType<TaxonomyAdminCatalogRepository["editItem"]>>> {
  await sql`SELECT pg_advisory_xact_lock(1301001)`;
  const [replay] = await sql<
    { readonly fingerprint: string | null; readonly targetId: string }[]
  >`
    SELECT lower(changes #>> '{profile_state,after}') AS fingerprint,
      target_id AS "targetId"
    FROM audit_events
    WHERE event_id = ${input.commandId}
  `;
  if (replay !== undefined) {
    if (
      replay.fingerprint !== input.fingerprint ||
      replay.targetId !== input.sourceTaxonomyCode
    ) {
      throw new TaxonomySuggestionIdempotencyError(
        "Taxonomy edit command id was reused with different intent.",
      );
    }
    const item = await findCatalogItemWithSql(sql, input.canonicalCode);
    if (item === null) throw new Error("Edited taxonomy item is missing.");
    return { item, status: "DEDUPLICATED" };
  }

  const [current] = await sql<
    {
      readonly checksum: string;
      readonly releaseId: string;
      readonly version: number;
    }[]
  >`
    SELECT release.release_id AS "releaseId", release.version,
      release.checksum_sha256 AS checksum
    FROM profession_taxonomy_activation_events activation
    JOIN profession_taxonomy_releases release
      ON release.release_id = activation.release_id
    ORDER BY activation.activation_sequence DESC
    LIMIT 1
    FOR UPDATE OF activation
  `;
  if (current === undefined)
    throw new Error("Current taxonomy release is missing.");
  if (current.version !== input.expectedReleaseVersion) {
    return { code: "STALE_RELEASE", status: "CONFLICT" };
  }
  const source = await findCatalogItemWithSql(sql, input.sourceTaxonomyCode);
  if (source === null) return { code: "ITEM_UNAVAILABLE", status: "CONFLICT" };
  if (input.canonicalCode !== input.sourceTaxonomyCode) {
    const conflict = await findCatalogItemWithSql(sql, input.canonicalCode);
    if (conflict !== null) {
      return { code: "CANONICAL_CODE_CONFLICT", status: "CONFLICT" };
    }
  }

  if (
    (source.kind !== input.kind ||
      source.code !== input.canonicalCode ||
      (source.kind === "PROFESSION" && input.state === "DEPRECATED")) &&
    (await taxonomyItemHasDependencies(sql, current.releaseId, source))
  ) {
    return { code: "DEPENDENCIES_EXIST", status: "CONFLICT" };
  }
  if (
    input.replacedByCode !== null &&
    !(await activeTargetExists(sql, input.kind, input.replacedByCode))
  ) {
    return { code: "REPLACEMENT_UNAVAILABLE", status: "CONFLICT" };
  }
  if (
    input.kind === "SERVICE" &&
    !(await allActiveProfessionsExist(sql, input.professionCodes))
  ) {
    return { code: "REPLACEMENT_UNAVAILABLE", status: "CONFLICT" };
  }
  const aliasConflicts = await findAliasConflicts(sql, input);
  if (aliasConflicts.length > 0) {
    return { aliasConflicts, status: "ALIAS_CONFLICT" };
  }

  const releaseId = randomUUID();
  const reviewReference = `taxonomy-admin-edit:${input.commandId}`;
  await sql`
    INSERT INTO profession_taxonomy_releases (
      release_id, version, content_class, review_state, review_reference,
      supersedes_release_id, checksum_sha256
    ) VALUES (${releaseId}, ${current.version + 1}, 'CANONICAL',
      'HUMAN_REVIEW_APPROVED', ${reviewReference}, ${current.releaseId},
      ${hash([current.checksum, input.fingerprint])})
  `;
  await copyCatalogReleaseForEdit(sql, current.releaseId, releaseId, source);
  await insertEditedCatalogItem(sql, releaseId, input);
  await sql`
    INSERT INTO taxonomy_specializations
    SELECT ${releaseId}, specialization_code, profession_code, slug,
      label_sk, state, replaced_by_code
    FROM taxonomy_specializations WHERE release_id = ${current.releaseId}
  `;
  await sql`
    INSERT INTO taxonomy_capability_criteria
    SELECT ${releaseId}, criterion_code, profession_code, level,
      label_sk, description_sk, state
    FROM taxonomy_capability_criteria WHERE release_id = ${current.releaseId}
  `;
  await copyServiceProfessionLinksForEdit(
    sql,
    current.releaseId,
    releaseId,
    source,
    input,
  );
  await sql`
    INSERT INTO taxonomy_aliases
    SELECT ${releaseId}, alias, alias_kind, target_kind, target_code
    FROM taxonomy_aliases
    WHERE release_id = ${current.releaseId}
      AND NOT (target_kind = ${source.kind} AND target_code = ${source.code})
  `;
  for (const alias of input.aliases) {
    await insertAlias(sql, releaseId, alias, input.kind, input.canonicalCode);
  }
  await sql`
    INSERT INTO profession_taxonomy_activation_events (
      activation_id, release_id, previous_release_id,
      actor_reference, review_reference
    ) VALUES (${randomUUID()}, ${releaseId}, ${current.releaseId},
      ${`admin-user:${input.actorAdminUserId}`}, ${reviewReference})
  `;
  const changes = JSON.stringify({
    profile_state: {
      after: input.fingerprint.toUpperCase(),
      before: hash(["taxonomy-item", input.sourceTaxonomyCode]).toUpperCase(),
    },
  });
  await sql`
    INSERT INTO audit_events (
      event_id, correlation_id, category, actor_kind, actor_user_id,
      actor_capability, action_type, target_type, target_id, reason, changes
    ) VALUES (${input.commandId}, ${input.commandId}, 'PRIVILEGED_COMMAND',
      'AUTHENTICATED_USER', ${input.actorAdminUserId}, 'admin.taxonomy.manage',
      'taxonomy.catalog.edit', 'TAXONOMY_ITEM', ${input.sourceTaxonomyCode},
      ${input.adminReason}, ${changes}::jsonb)
  `;
  const item = await findCatalogItemWithSql(sql, input.canonicalCode);
  if (item === null) throw new Error("Activated taxonomy item is missing.");
  return { item, status: "APPLIED" };
}

async function copyCatalogReleaseForEdit(
  sql: TransactionSql,
  previousReleaseId: string,
  releaseId: string,
  source: TaxonomyAdminCatalogItem,
): Promise<void> {
  await sql`
    INSERT INTO taxonomy_professions
    SELECT ${releaseId}, profession_code, slug, label_sk, description_sk,
      state, replaced_by_code
    FROM taxonomy_professions
    WHERE release_id = ${previousReleaseId}
      AND NOT (${source.kind} = 'PROFESSION' AND profession_code = ${source.code})
  `;
  await sql`
    INSERT INTO taxonomy_services
    SELECT ${releaseId}, service_code, slug, label_sk, description_sk,
      state, replaced_by_code
    FROM taxonomy_services
    WHERE release_id = ${previousReleaseId}
      AND NOT (${source.kind} = 'SERVICE' AND service_code = ${source.code})
  `;
}

async function insertEditedCatalogItem(
  sql: TransactionSql,
  releaseId: string,
  input: NormalizedCatalogEdit,
): Promise<void> {
  const slug = slugify(input.name);
  if (input.kind === "PROFESSION") {
    await sql`
      INSERT INTO taxonomy_professions (
        release_id, profession_code, slug, label_sk, description_sk,
        state, replaced_by_code
      ) VALUES (${releaseId}, ${input.canonicalCode}, ${slug}, ${input.name},
        ${input.description}, ${input.state}, ${input.replacedByCode})
    `;
    return;
  }
  await sql`
    INSERT INTO taxonomy_services (
      release_id, service_code, slug, label_sk, description_sk,
      state, replaced_by_code
    ) VALUES (${releaseId}, ${input.canonicalCode}, ${slug}, ${input.name},
      ${input.description}, ${input.state}, ${input.replacedByCode})
  `;
}

async function copyServiceProfessionLinksForEdit(
  sql: TransactionSql,
  previousReleaseId: string,
  releaseId: string,
  source: TaxonomyAdminCatalogItem,
  input: NormalizedCatalogEdit,
): Promise<void> {
  await sql`
    INSERT INTO taxonomy_service_professions
    SELECT ${releaseId}, service_code, profession_code, is_primary
    FROM taxonomy_service_professions
    WHERE release_id = ${previousReleaseId}
      AND NOT (${source.kind} = 'SERVICE' AND service_code = ${source.code})
  `;
  if (input.kind !== "SERVICE") return;
  for (const professionCode of input.professionCodes) {
    await sql`
      INSERT INTO taxonomy_service_professions (
        release_id, service_code, profession_code, is_primary
      ) VALUES (${releaseId}, ${input.canonicalCode}, ${professionCode},
        ${professionCode === input.primaryProfessionCode})
    `;
  }
}

async function findCatalogItemWithSql(
  sql: TransactionSql,
  code: string,
): Promise<TaxonomyAdminCatalogItem | null> {
  const [row] = await sql.unsafe<TaxonomyAdminCatalogItem[]>(
    `${catalogSelect} WHERE item.code = $1`,
    [code],
  );
  return row === undefined ? null : freezeCatalogItem(row);
}

async function taxonomyItemHasDependencies(
  sql: TransactionSql,
  releaseId: string,
  source: TaxonomyAdminCatalogItem,
): Promise<boolean> {
  if (source.kind === "SERVICE") return false;
  const [row] = await sql<{ readonly dependent: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM taxonomy_service_professions
      WHERE release_id = ${releaseId} AND profession_code = ${source.code}
      UNION ALL
      SELECT 1 FROM taxonomy_specializations
      WHERE release_id = ${releaseId} AND profession_code = ${source.code}
      UNION ALL
      SELECT 1 FROM taxonomy_capability_criteria
      WHERE release_id = ${releaseId} AND profession_code = ${source.code}
    ) AS dependent
  `;
  return row?.dependent === true;
}

async function activeTargetExists(
  sql: TransactionSql,
  kind: TaxonomyAdminCatalogKind,
  code: string,
): Promise<boolean> {
  return targetExists(sql, kind, code);
}

async function allActiveProfessionsExist(
  sql: TransactionSql,
  codes: readonly string[],
): Promise<boolean> {
  const [row] = await sql<{ readonly count: number }[]>`
    SELECT count(*)::integer AS count
    FROM current_profession_taxonomy
    WHERE profession_code = ANY(${codes}) AND state = 'ACTIVE'
  `;
  return row?.count === codes.length;
}

async function findAliasConflicts(
  sql: TransactionSql,
  input: NormalizedCatalogEdit,
): Promise<readonly TaxonomyAdminAliasConflict[]> {
  const aliases = [input.name, ...input.aliases].map(aliasSlug);
  const rows = await sql<TaxonomyAdminAliasConflict[]>`
    WITH candidates(alias) AS (SELECT unnest(${aliases}::text[])),
    current_release AS (
      SELECT release_id FROM profession_taxonomy_activation_events
      ORDER BY activation_sequence DESC LIMIT 1
    ), conflicts AS (
      SELECT candidate.alias, profession.profession_code AS "conflictingCode",
        'PROFESSION'::text AS "conflictingKind",
        profession.label_sk AS "conflictingName"
      FROM candidates candidate CROSS JOIN current_release current
      JOIN taxonomy_professions profession ON profession.release_id = current.release_id
        AND profession.slug = candidate.alias
      WHERE profession.profession_code <> ${input.sourceTaxonomyCode}
      UNION ALL
      SELECT candidate.alias, service.service_code, 'SERVICE'::text,
        service.label_sk
      FROM candidates candidate CROSS JOIN current_release current
      JOIN taxonomy_services service ON service.release_id = current.release_id
        AND service.slug = candidate.alias
      WHERE service.service_code <> ${input.sourceTaxonomyCode}
      UNION ALL
      SELECT candidate.alias, alias.target_code, alias.target_kind::text,
        CASE alias.target_kind
          WHEN 'PROFESSION' THEN profession.label_sk
          WHEN 'SERVICE' THEN service.label_sk
          ELSE alias.target_code
        END
      FROM candidates candidate CROSS JOIN current_release current
      JOIN taxonomy_aliases alias ON alias.release_id = current.release_id
        AND portal_taxonomy_normalize(alias.alias) = portal_taxonomy_normalize(candidate.alias)
      LEFT JOIN taxonomy_professions profession
        ON profession.release_id = alias.release_id
        AND alias.target_kind = 'PROFESSION'
        AND profession.profession_code = alias.target_code
      LEFT JOIN taxonomy_services service
        ON service.release_id = alias.release_id
        AND alias.target_kind = 'SERVICE'
        AND service.service_code = alias.target_code
      WHERE alias.target_kind IN ('PROFESSION', 'SERVICE')
        AND alias.target_code <> ${input.sourceTaxonomyCode}
    )
    SELECT DISTINCT alias, "conflictingCode", "conflictingKind",
      "conflictingName"
    FROM conflicts
    ORDER BY alias, "conflictingKind", "conflictingName", "conflictingCode"
  `;
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

function normalizeCatalogQuery(value: string | null): string | null {
  if (value === null) return null;
  return normalizeRequiredCatalogQuery(value);
}

function normalizeRequiredCatalogQuery(value: string): string {
  const normalized = normalizeCatalogText(value, 2, 100, "query");
  return normalized;
}

function normalizeCatalogText(
  value: string,
  minimum: number,
  maximum: number,
  field: string,
): string {
  if (typeof value !== "string") throw new TypeError(`Invalid ${field}.`);
  const normalized = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (
    normalized.length < minimum ||
    normalized.length > maximum ||
    /\p{Cc}/u.test(normalized)
  ) {
    throw new TypeError(`Invalid ${field}.`);
  }
  return normalized;
}

function assertCatalogLimit(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError("Invalid taxonomy catalog limit.");
  }
}

function assertTaxonomyCode(value: string): void {
  if (!/^(?:PROF|SERV):[A-Z][A-Z0-9_]{1,62}$/u.test(value)) {
    throw new TypeError("Invalid taxonomy code.");
  }
}

function assertUuid(value: string, field: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new TypeError(`Invalid ${field}.`);
  }
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown): item is string => typeof item === "string")
  );
}

function freezeCatalogRows(
  rows: readonly TaxonomyAdminCatalogItem[],
): readonly TaxonomyAdminCatalogItem[] {
  return Object.freeze(rows.map(freezeCatalogItem));
}

function freezeCatalogItem(
  row: TaxonomyAdminCatalogItem,
): TaxonomyAdminCatalogItem {
  return Object.freeze({
    ...row,
    aliases: Object.freeze([...row.aliases]),
    professionCodes: Object.freeze([...row.professionCodes]),
  });
}

const suggestionSelect = `SELECT suggestion.id, suggestion.requester_user_id AS "requesterUserId",
  suggestion.requester_craftsman_profile_id AS "requesterCraftsmanProfileId",
  suggestion.proposed_name AS "proposedName", suggestion.normalized_proposed_name AS "normalizedProposedName",
  suggestion.proposed_description AS "proposedDescription", suggestion.suggested_kind AS "suggestedKind",
  suggestion.state, suggestion.revision, suggestion.created_at AS "createdAt",
  suggestion.decided_at AS "decidedAt", suggestion.decided_by_admin_id AS "decidedByAdminId",
  suggestion.admin_decision_note AS "adminDecisionNote",
  suggestion.resolved_taxonomy_code AS "resolvedTaxonomyCode",
  suggestion.resolved_taxonomy_label AS "resolvedTaxonomyLabel"
  FROM current_taxonomy_suggestions suggestion`;

async function getSuggestion(
  sql: TransactionSql,
  id: string,
): Promise<TaxonomySuggestion | null> {
  const rows = await sql.unsafe<SuggestionRow[]>(
    `${suggestionSelect} WHERE suggestion.id = $1`,
    [id],
  );
  return rows[0] === undefined ? null : freeze(rows[0]);
}

async function mustGetSuggestion(
  sql: TransactionSql,
  id: string,
): Promise<TaxonomySuggestion> {
  const suggestion = await getSuggestion(sql, id);
  if (suggestion === null) {
    throw new Error("Committed taxonomy suggestion projection is missing.");
  }
  return suggestion;
}

function freeze(row: SuggestionRow): TaxonomySuggestion {
  return Object.freeze({ ...row });
}
function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}
function decisionFingerprint(input: DecideTaxonomySuggestionInput): unknown[] {
  return [
    input.decision,
    ...Object.keys(input)
      .sort()
      .map((key) => (input as unknown as Record<string, unknown>)[key]),
  ];
}
function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 100);
}
function aliasSlug(value: string): string {
  return slugify(value);
}

async function targetExists(
  sql: TransactionSql,
  kind: "PROFESSION" | "SERVICE",
  code: string,
): Promise<boolean> {
  const [row] =
    kind === "PROFESSION"
      ? await sql<
          { exists: boolean }[]
        >`SELECT EXISTS (SELECT 1 FROM current_profession_taxonomy WHERE profession_code = ${code} AND state = 'ACTIVE') AS exists`
      : await sql<
          { exists: boolean }[]
        >`SELECT EXISTS (SELECT 1 FROM current_service_taxonomy WHERE service_code = ${code} AND state = 'ACTIVE') AS exists`;
  return row?.exists === true;
}
async function targetLabel(
  sql: TransactionSql,
  kind: "PROFESSION" | "SERVICE",
  code: string,
): Promise<string | null> {
  const [row] =
    kind === "PROFESSION"
      ? await sql<{ label: string }[]>`
        SELECT label_sk AS label FROM current_profession_taxonomy
        WHERE profession_code = ${code} AND state = 'ACTIVE'
      `
      : await sql<{ label: string }[]>`
        SELECT label_sk AS label FROM current_service_taxonomy
        WHERE service_code = ${code} AND state = 'ACTIVE'
      `;
  return row?.label ?? null;
}
async function targetCodeExists(
  sql: TransactionSql,
  code: string,
): Promise<boolean> {
  const [row] = await sql<{ exists: boolean }[]>`SELECT EXISTS (
    SELECT 1 FROM current_profession_taxonomy WHERE profession_code = ${code}
    UNION ALL SELECT 1 FROM current_service_taxonomy WHERE service_code = ${code}
  ) AS exists`;
  return row?.exists === true;
}
async function anyAliasValueConflicts(
  sql: TransactionSql,
  values: readonly string[],
): Promise<boolean> {
  for (const value of values) {
    if (await aliasValueConflicts(sql, value)) return true;
  }
  return false;
}
async function aliasValueConflicts(
  sql: TransactionSql,
  value: string,
): Promise<boolean> {
  const alias = aliasSlug(value);
  const [row] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM current_profession_taxonomy WHERE slug = ${alias}
      UNION ALL SELECT 1 FROM current_service_taxonomy WHERE slug = ${alias}
      UNION ALL SELECT 1 FROM current_specialization_taxonomy WHERE slug = ${alias}
      UNION ALL SELECT 1 FROM current_taxonomy_aliases
        WHERE portal_taxonomy_normalize(alias) = portal_taxonomy_normalize(${alias})
    ) AS exists
  `;
  return row?.exists === true;
}

async function cloneCurrentRelease(
  sql: TransactionSql,
  commandId: string,
  actorId: string,
) {
  await sql`SELECT pg_advisory_xact_lock(1301001)`;
  const [current] = await sql<
    { checksum: string; releaseId: string; version: number }[]
  >`
    SELECT release.release_id AS "releaseId", release.version,
      release.checksum_sha256 AS checksum
    FROM profession_taxonomy_activation_events activation
    JOIN profession_taxonomy_releases release ON release.release_id = activation.release_id
    ORDER BY activation.activation_sequence DESC LIMIT 1 FOR UPDATE OF activation
  `;
  if (current === undefined)
    throw new Error("Current taxonomy release is missing.");
  const releaseId = randomUUID();
  const reviewReference = `taxonomy-admin:${commandId}`;
  await sql`INSERT INTO profession_taxonomy_releases (release_id, version,
    content_class, review_state, review_reference, supersedes_release_id, checksum_sha256)
    VALUES (${releaseId}, ${current.version + 1}, 'CANONICAL', 'HUMAN_REVIEW_APPROVED',
      ${reviewReference}, ${current.releaseId}, ${hash([current.checksum, commandId])})`;
  await sql`INSERT INTO taxonomy_professions (
      release_id, profession_code, slug, label_sk, description_sk, state, replaced_by_code
    ) SELECT ${releaseId}, profession_code, slug, label_sk, description_sk, state,
      replaced_by_code FROM taxonomy_professions WHERE release_id = ${current.releaseId}`;
  await sql`INSERT INTO taxonomy_services (
      release_id, service_code, slug, label_sk, description_sk, state, replaced_by_code
    ) SELECT ${releaseId}, service_code, slug, label_sk, description_sk, state,
      replaced_by_code FROM taxonomy_services WHERE release_id = ${current.releaseId}`;
  await sql`INSERT INTO taxonomy_specializations (
      release_id, specialization_code, profession_code, slug, label_sk, state,
      replaced_by_code
    ) SELECT ${releaseId}, specialization_code, profession_code, slug, label_sk,
      state, replaced_by_code FROM taxonomy_specializations
      WHERE release_id = ${current.releaseId}`;
  await sql`INSERT INTO taxonomy_capability_criteria (
      release_id, criterion_code, profession_code, level, label_sk, description_sk, state
    ) SELECT ${releaseId}, criterion_code, profession_code, level, label_sk,
      description_sk, state FROM taxonomy_capability_criteria
      WHERE release_id = ${current.releaseId}`;
  await sql`INSERT INTO taxonomy_service_professions (
      release_id, service_code, profession_code, is_primary
    ) SELECT ${releaseId}, service_code, profession_code, is_primary
      FROM taxonomy_service_professions WHERE release_id = ${current.releaseId}`;
  await sql`INSERT INTO taxonomy_aliases (
      release_id, alias, alias_kind, target_kind, target_code
    ) SELECT ${releaseId}, alias, alias_kind, target_kind, target_code
      FROM taxonomy_aliases WHERE release_id = ${current.releaseId}`;
  return {
    actorId,
    previousReleaseId: current.releaseId,
    releaseId,
    reviewReference,
  };
}

async function insertAlias(
  sql: TransactionSql,
  releaseId: string,
  value: string,
  kind: "PROFESSION" | "SERVICE",
  code: string,
): Promise<void> {
  const alias = aliasSlug(value);
  if (alias.length < 2) throw new TypeError("Invalid taxonomy alias.");
  await sql`INSERT INTO taxonomy_aliases (release_id, alias, alias_kind, target_kind, target_code)
    VALUES (${releaseId}, ${alias}, 'SEARCH_TERM', ${kind}, ${code})`;
}

async function activateRelease(
  sql: TransactionSql,
  release: {
    actorId: string;
    previousReleaseId: string;
    releaseId: string;
    reviewReference: string;
  },
): Promise<void> {
  await sql`INSERT INTO profession_taxonomy_activation_events (activation_id,
    release_id, previous_release_id, actor_reference, review_reference)
    VALUES (${randomUUID()}, ${release.releaseId}, ${release.previousReleaseId},
      ${`admin-user:${release.actorId}`}, ${release.reviewReference})`;
}

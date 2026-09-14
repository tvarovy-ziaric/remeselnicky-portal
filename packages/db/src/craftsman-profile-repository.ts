import type {
  CompanyCraftsmanProfile,
  CraftsmanProfile,
  CraftsmanProfileId,
  CraftsmanProfilePersistence,
  CreateCraftsmanProfileDraftInput,
  CreateCraftsmanProfileDraftResult,
  IndividualCraftsmanProfile,
  ReplaceCraftsmanProfileDraftInput,
  ReplaceCraftsmanProfileDraftResult,
  UserId,
  VerificationFact,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

interface CraftsmanProfileRow {
  readonly about: string | null;
  readonly companyRegistrationNumber: string | null;
  readonly companyRegistrationVerificationReference: string | null;
  readonly companyRegistrationVerifiedAt: Date | null;
  readonly createdAt: Date;
  readonly id: string;
  readonly identityVerificationReference: string | null;
  readonly identityVerifiedAt: Date | null;
  readonly nickname: string | null;
  readonly officialCompanyName: string | null;
  readonly ownerUserId: string;
  readonly profileType: "INDIVIDUAL" | "COMPANY";
  readonly realFirstName: string | null;
  readonly realLastName: string | null;
  readonly revision: number;
  readonly updatedAt: Date;
}

interface LockedCraftsmanProfileRow extends CraftsmanProfileRow {
  readonly ownerAccountState: "ACTIVE" | "SUSPENDED" | "DEACTIVATED";
}

interface OwnerStateRow {
  readonly accountState: "ACTIVE" | "SUSPENDED" | "DEACTIVATED";
}

/**
 * Server-only persistence for the owner-scoped private draft. All mutable
 * commands lock the owner row, making an account-state transition serialize
 * with the ACTIVE eligibility decision.
 */
export function createCraftsmanProfileRepository(
  sql: Sql,
): CraftsmanProfilePersistence {
  return Object.freeze({
    async createPrivateDraft(
      input: CreateCraftsmanProfileDraftInput,
    ): Promise<CreateCraftsmanProfileDraftResult> {
      return sql.begin(async (transaction) => {
        const [owner] = await transaction<OwnerStateRow[]>`
          SELECT account_state AS "accountState"
          FROM users
          WHERE id = ${input.actorUserId}
          FOR UPDATE
        `;
        if (owner?.accountState !== "ACTIVE") {
          return Object.freeze({ status: "OWNER_NOT_ACTIVE" });
        }

        const [existing] = await selectOwnedProfile(
          transaction,
          input.actorUserId,
        );
        if (existing !== undefined) {
          if (draftMatchesCreateInput(existing, input)) {
            return Object.freeze({
              profile: mapProfile(existing),
              status: "UNCHANGED",
            });
          }
          return Object.freeze({ status: "ALREADY_EXISTS" });
        }

        const details = createDetails(input);
        const [created] = await transaction<CraftsmanProfileRow[]>`
          INSERT INTO craftsman_profiles (
            owner_user_id,
            profile_type,
            real_first_name,
            real_last_name,
            nickname,
            official_company_name,
            company_registration_number,
            about
          ) VALUES (
            ${input.actorUserId},
            ${input.profileType},
            ${details.realFirstName},
            ${details.realLastName},
            ${details.nickname},
            ${details.officialCompanyName},
            ${details.companyRegistrationNumber},
            ${details.about}
          )
          RETURNING
            id,
            owner_user_id AS "ownerUserId",
            profile_type AS "profileType",
            real_first_name AS "realFirstName",
            real_last_name AS "realLastName",
            nickname,
            official_company_name AS "officialCompanyName",
            company_registration_number AS "companyRegistrationNumber",
            about,
            identity_verified_at AS "identityVerifiedAt",
            identity_verification_reference AS "identityVerificationReference",
            company_registration_verified_at AS "companyRegistrationVerifiedAt",
            company_registration_verification_reference
              AS "companyRegistrationVerificationReference",
            revision,
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `;
        if (created === undefined) {
          throw new Error("Craftsman draft insert returned no record.");
        }
        return Object.freeze({
          profile: mapProfile(created),
          status: "CREATED",
        });
      });
    },

    async findOwnedPrivateDraft(
      actorUserId: UserId,
      profileId: CraftsmanProfileId,
    ): Promise<CraftsmanProfile | null> {
      const [profile] = await sql<CraftsmanProfileRow[]>`
        SELECT
          profile.id,
          profile.owner_user_id AS "ownerUserId",
          profile.profile_type AS "profileType",
          profile.real_first_name AS "realFirstName",
          profile.real_last_name AS "realLastName",
          profile.nickname,
          profile.official_company_name AS "officialCompanyName",
          profile.company_registration_number AS "companyRegistrationNumber",
          profile.about,
          profile.identity_verified_at AS "identityVerifiedAt",
          profile.identity_verification_reference AS "identityVerificationReference",
          profile.company_registration_verified_at AS "companyRegistrationVerifiedAt",
          profile.company_registration_verification_reference
            AS "companyRegistrationVerificationReference",
          profile.revision,
          profile.created_at AS "createdAt",
          profile.updated_at AS "updatedAt"
        FROM craftsman_profiles profile
        JOIN users ON users.id = profile.owner_user_id
          AND users.account_state = 'ACTIVE'
        WHERE profile.id = ${profileId}
          AND profile.owner_user_id = ${actorUserId}
      `;
      return profile === undefined ? null : mapProfile(profile);
    },

    async replacePrivateDraft(
      input: ReplaceCraftsmanProfileDraftInput,
    ): Promise<ReplaceCraftsmanProfileDraftResult> {
      return sql.begin(async (transaction) => {
        const [locked] = await transaction<LockedCraftsmanProfileRow[]>`
          SELECT
            craftsman_profiles.id,
            craftsman_profiles.owner_user_id AS "ownerUserId",
            craftsman_profiles.profile_type AS "profileType",
            craftsman_profiles.real_first_name AS "realFirstName",
            craftsman_profiles.real_last_name AS "realLastName",
            craftsman_profiles.nickname,
            craftsman_profiles.official_company_name AS "officialCompanyName",
            craftsman_profiles.company_registration_number
              AS "companyRegistrationNumber",
            craftsman_profiles.about,
            craftsman_profiles.identity_verified_at AS "identityVerifiedAt",
            craftsman_profiles.identity_verification_reference
              AS "identityVerificationReference",
            craftsman_profiles.company_registration_verified_at
              AS "companyRegistrationVerifiedAt",
            craftsman_profiles.company_registration_verification_reference
              AS "companyRegistrationVerificationReference",
            craftsman_profiles.revision,
            craftsman_profiles.created_at AS "createdAt",
            craftsman_profiles.updated_at AS "updatedAt",
            users.account_state AS "ownerAccountState"
          FROM craftsman_profiles
          JOIN users ON users.id = craftsman_profiles.owner_user_id
          WHERE craftsman_profiles.id = ${input.profileId}
            AND craftsman_profiles.owner_user_id = ${input.actorUserId}
          FOR UPDATE OF craftsman_profiles, users
        `;
        if (locked === undefined) {
          return Object.freeze({ status: "NOT_FOUND" });
        }
        if (locked.ownerAccountState !== "ACTIVE") {
          return Object.freeze({ status: "OWNER_NOT_ACTIVE" });
        }
        if (locked.profileType !== input.profileType) {
          return Object.freeze({ status: "PROFILE_TYPE_MISMATCH" });
        }
        if (draftMatchesReplaceInput(locked, input)) {
          return Object.freeze({
            profile: mapProfile(locked),
            status: "UNCHANGED",
          });
        }
        if (locked.revision !== input.expectedRevision) {
          return Object.freeze({ status: "STALE_REVISION" });
        }

        const details = replaceDetails(input);
        const [updated] = await transaction<CraftsmanProfileRow[]>`
          UPDATE craftsman_profiles
          SET
            real_first_name = ${details.realFirstName},
            real_last_name = ${details.realLastName},
            nickname = ${details.nickname},
            official_company_name = ${details.officialCompanyName},
            company_registration_number = ${details.companyRegistrationNumber},
            about = ${details.about},
            identity_verified_at = CASE
              WHEN ROW(profile_type, real_first_name, real_last_name, official_company_name)
                IS DISTINCT FROM ROW(
                  profile_type,
                  ${details.realFirstName},
                  ${details.realLastName},
                  ${details.officialCompanyName}
                )
              THEN NULL
              ELSE identity_verified_at
            END,
            identity_verification_reference = CASE
              WHEN ROW(profile_type, real_first_name, real_last_name, official_company_name)
                IS DISTINCT FROM ROW(
                  profile_type,
                  ${details.realFirstName},
                  ${details.realLastName},
                  ${details.officialCompanyName}
                )
              THEN NULL
              ELSE identity_verification_reference
            END,
            company_registration_verified_at = CASE
              WHEN company_registration_number
                IS DISTINCT FROM ${details.companyRegistrationNumber}
              THEN NULL
              ELSE company_registration_verified_at
            END,
            company_registration_verification_reference = CASE
              WHEN company_registration_number
                IS DISTINCT FROM ${details.companyRegistrationNumber}
              THEN NULL
              ELSE company_registration_verification_reference
            END
          WHERE id = ${input.profileId}
            AND owner_user_id = ${input.actorUserId}
            AND revision = ${input.expectedRevision}
          RETURNING
            id,
            owner_user_id AS "ownerUserId",
            profile_type AS "profileType",
            real_first_name AS "realFirstName",
            real_last_name AS "realLastName",
            nickname,
            official_company_name AS "officialCompanyName",
            company_registration_number AS "companyRegistrationNumber",
            about,
            identity_verified_at AS "identityVerifiedAt",
            identity_verification_reference AS "identityVerificationReference",
            company_registration_verified_at AS "companyRegistrationVerifiedAt",
            company_registration_verification_reference
              AS "companyRegistrationVerificationReference",
            revision,
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `;
        if (updated === undefined) {
          throw new Error("Locked craftsman draft update lost its revision.");
        }
        return Object.freeze({
          profile: mapProfile(updated),
          status: "UPDATED",
        });
      });
    },
  });
}

async function selectOwnedProfile(
  transaction: TransactionSql,
  ownerUserId: UserId,
): Promise<CraftsmanProfileRow[]> {
  return transaction<CraftsmanProfileRow[]>`
    SELECT
      id,
      owner_user_id AS "ownerUserId",
      profile_type AS "profileType",
      real_first_name AS "realFirstName",
      real_last_name AS "realLastName",
      nickname,
      official_company_name AS "officialCompanyName",
      company_registration_number AS "companyRegistrationNumber",
      about,
      identity_verified_at AS "identityVerifiedAt",
      identity_verification_reference AS "identityVerificationReference",
      company_registration_verified_at AS "companyRegistrationVerifiedAt",
      company_registration_verification_reference
        AS "companyRegistrationVerificationReference",
      revision,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM craftsman_profiles
    WHERE owner_user_id = ${ownerUserId}
  `;
}

interface DraftDetails {
  readonly about: string | null;
  readonly companyRegistrationNumber: string | null;
  readonly nickname: string | null;
  readonly officialCompanyName: string | null;
  readonly realFirstName: string | null;
  readonly realLastName: string | null;
}

function createDetails(input: CreateCraftsmanProfileDraftInput): DraftDetails {
  return input.profileType === "INDIVIDUAL"
    ? {
        about: input.about ?? null,
        companyRegistrationNumber: null,
        nickname: input.nickname ?? null,
        officialCompanyName: null,
        realFirstName: input.realFirstName ?? null,
        realLastName: input.realLastName ?? null,
      }
    : {
        about: input.about ?? null,
        companyRegistrationNumber: input.companyRegistrationNumber ?? null,
        nickname: null,
        officialCompanyName: input.officialCompanyName ?? null,
        realFirstName: null,
        realLastName: null,
      };
}

function replaceDetails(
  input: ReplaceCraftsmanProfileDraftInput,
): DraftDetails {
  return input.profileType === "INDIVIDUAL"
    ? {
        about: input.about,
        companyRegistrationNumber: null,
        nickname: input.nickname,
        officialCompanyName: null,
        realFirstName: input.realFirstName,
        realLastName: input.realLastName,
      }
    : {
        about: input.about,
        companyRegistrationNumber: input.companyRegistrationNumber,
        nickname: null,
        officialCompanyName: input.officialCompanyName,
        realFirstName: null,
        realLastName: null,
      };
}

function draftMatchesCreateInput(
  row: CraftsmanProfileRow,
  input: CreateCraftsmanProfileDraftInput,
): boolean {
  const details = createDetails(input);
  return row.profileType === input.profileType && detailsMatch(row, details);
}

function draftMatchesReplaceInput(
  row: CraftsmanProfileRow,
  input: ReplaceCraftsmanProfileDraftInput,
): boolean {
  return detailsMatch(row, replaceDetails(input));
}

function detailsMatch(
  row: CraftsmanProfileRow,
  details: DraftDetails,
): boolean {
  return (
    row.about === details.about &&
    row.companyRegistrationNumber === details.companyRegistrationNumber &&
    row.nickname === details.nickname &&
    row.officialCompanyName === details.officialCompanyName &&
    row.realFirstName === details.realFirstName &&
    row.realLastName === details.realLastName
  );
}

function mapProfile(row: CraftsmanProfileRow): CraftsmanProfile {
  const shared = {
    about: row.about,
    createdAt: row.createdAt,
    id: row.id as CraftsmanProfileId,
    identityVerification: verification(
      row.identityVerifiedAt,
      row.identityVerificationReference,
    ),
    ownerUserId: row.ownerUserId as UserId,
    revision: row.revision,
    updatedAt: row.updatedAt,
  };
  if (row.profileType === "INDIVIDUAL") {
    return Object.freeze({
      ...shared,
      nickname: row.nickname,
      profileType: row.profileType,
      realFirstName: row.realFirstName,
      realLastName: row.realLastName,
    } satisfies IndividualCraftsmanProfile);
  }
  return Object.freeze({
    ...shared,
    companyRegistrationNumber: row.companyRegistrationNumber,
    companyRegistrationVerification: verification(
      row.companyRegistrationVerifiedAt,
      row.companyRegistrationVerificationReference,
    ),
    officialCompanyName: row.officialCompanyName,
    profileType: row.profileType,
  } satisfies CompanyCraftsmanProfile);
}

function verification(
  verifiedAt: Date | null,
  reference: string | null,
): VerificationFact | null {
  if (verifiedAt === null || reference === null) {
    return null;
  }
  return Object.freeze({ reference, verifiedAt });
}

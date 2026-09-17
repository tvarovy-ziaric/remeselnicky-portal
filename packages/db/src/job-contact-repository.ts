import type { Sql, TransactionSql } from "postgres";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface JobContactDetails {
  readonly jobId: string;
  readonly locationRevision: number;
  readonly customer: Readonly<{ email: string | null; phone: string | null }>;
  readonly provider: Readonly<{ email: string | null; phone: string | null }>;
  readonly workLocation: Readonly<{
    municipalityCode: string;
    exactAddress: string | null;
    mapPin: Readonly<{ latitude: number; longitude: number }> | null;
    textClarification: string | null;
  }>;
}

interface ContactRow {
  readonly customerEmail: string | null;
  readonly customerPhone: string | null;
  readonly jobId: string;
  readonly locationPayload: unknown;
  readonly locationRevision: number;
  readonly providerEmail: string | null;
  readonly providerPhone: string | null;
}

export function createJobContactRepository(sql: Sql | TransactionSql) {
  return Object.freeze({
    async readForPrimaryParty(input: {
      readonly actorUserId: string;
      readonly jobId: string;
    }): Promise<JobContactDetails | null> {
      if (!uuid.test(input.actorUserId) || !uuid.test(input.jobId)) {
        return null;
      }
      const [row] = await sql<ContactRow[]>`
        SELECT job.id AS "jobId",
          CASE WHEN customer_auth.email_verified_at IS NOT NULL
            THEN customer_auth.normalized_email ELSE NULL END
            AS "customerEmail",
          CASE WHEN customer_auth.phone_verified_at IS NOT NULL
            THEN customer_auth.normalized_phone ELSE NULL END
            AS "customerPhone",
          CASE WHEN provider_auth.email_verified_at IS NOT NULL
            THEN provider_auth.normalized_email ELSE NULL END
            AS "providerEmail",
          CASE WHEN provider_auth.phone_verified_at IS NOT NULL
            THEN provider_auth.normalized_phone ELSE NULL END
            AS "providerPhone",
          location.location_payload AS "locationPayload",
          location.revision AS "locationRevision"
        FROM jobs job
        JOIN job_acceptance_events accepted ON accepted.job_id = job.id
        JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
        JOIN job_system_timeline_events unlocked
          ON unlocked.job_id = job.id
          AND unlocked.source_acceptance_event_id = accepted.event_id
          AND unlocked.event_type = 'CONTACT_ADDRESS_UNLOCKED'
        JOIN current_job_locations location ON location.job_id = job.id
        JOIN customer_profiles customer
          ON customer.id = job.customer_profile_id
        JOIN craftsman_profiles provider
          ON provider.id = job.primary_craftsman_profile_id
        JOIN auth_credentials customer_auth
          ON customer_auth.user_id = customer.owner_user_id
        JOIN auth_credentials provider_auth
          ON provider_auth.user_id = provider.owner_user_id
        JOIN users viewer ON viewer.id = ${input.actorUserId}
          AND viewer.account_state = 'ACTIVE'
        WHERE job.id = ${input.jobId}
          AND job.initial_state = 'CONFIRMED'
          AND (
            customer.owner_user_id = viewer.id
            OR provider.owner_user_id = viewer.id
          )
      `;
      if (
        row === undefined ||
        !Number.isSafeInteger(row.locationRevision) ||
        row.locationRevision < 1
      )
        return null;
      const workLocation = parseLocation(row.locationPayload);
      if (workLocation === null) return null;
      return Object.freeze({
        customer: Object.freeze({
          email: row.customerEmail,
          phone: row.customerPhone,
        }),
        jobId: row.jobId,
        locationRevision: row.locationRevision,
        provider: Object.freeze({
          email: row.providerEmail,
          phone: row.providerPhone,
        }),
        workLocation,
      });
    },
  });
}

function parseLocation(
  value: unknown,
): JobContactDetails["workLocation"] | null {
  if (typeof value !== "object" || value === null) return null;
  const location = value as Record<string, unknown>;
  const municipalityCode = location["municipalityCode"];
  const exactAddress = location["exactAddress"];
  const textClarification = location["textClarification"];
  const mapPin = location["mapPin"];
  if (
    typeof municipalityCode !== "string" ||
    municipalityCode.length === 0 ||
    !optionalText(exactAddress) ||
    !optionalText(textClarification)
  ) {
    return null;
  }
  let parsedMapPin: JobContactDetails["workLocation"]["mapPin"] = null;
  if (mapPin !== undefined && mapPin !== null) {
    if (typeof mapPin !== "object") return null;
    const coordinates = mapPin as Record<string, unknown>;
    const latitude = coordinates["latitude"];
    const longitude = coordinates["longitude"];
    if (
      typeof latitude !== "number" ||
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      typeof longitude !== "number" ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180
    ) {
      return null;
    }
    parsedMapPin = Object.freeze({ latitude, longitude });
  }
  return Object.freeze({
    exactAddress: exactAddress ?? null,
    mapPin: parsedMapPin,
    municipalityCode,
    textClarification: textClarification ?? null,
  });
}

function optionalText(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

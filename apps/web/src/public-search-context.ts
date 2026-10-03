const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const publicSearchKeys = new Set([
  "afterProfileId",
  "endsAt",
  "filterIndicativelyAvailable",
  "identityQuery",
  "includeOutsideDeclaredArea",
  "limit",
  "municipalityCode",
  "professionCode",
  "serviceCode",
  "skillCodes",
  "sort",
  "specializationCode",
  "startsAt",
]);

export interface PublicSearchFormDefaults {
  readonly includeOutsideDeclaredArea: boolean;
  readonly municipalityCode: string | null;
  readonly municipalityLabel: string;
  readonly professionCode: string | null;
  readonly professionLabel: string;
  readonly serviceCode: string | null;
  readonly sort: "BEST_RATED" | "NEAREST" | "RECOMMENDED";
}

export function parsePublicSearchFormDefaults(
  parameters: Readonly<Record<string, string | readonly string[] | undefined>>,
): PublicSearchFormDefaults {
  const professionCode = single(parameters.professionCode);
  const serviceCode = single(parameters.serviceCode);
  const municipalityCode = single(parameters.municipalityCode);
  const sort = single(parameters.sort);
  const validMunicipalityCode =
    municipalityCode !== null &&
    municipalityCode.length <= 64 &&
    /^[A-Z0-9][A-Z0-9._:-]*$/u.test(municipalityCode)
      ? municipalityCode
      : null;
  return Object.freeze({
    includeOutsideDeclaredArea:
      validMunicipalityCode !== null &&
      single(parameters.includeOutsideDeclaredArea) === "true",
    municipalityCode: validMunicipalityCode,
    municipalityLabel: safeLabel(single(parameters.municipalityLabel), 80),
    professionCode:
      professionCode !== null &&
      /^(?:PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u.test(professionCode)
        ? professionCode
        : null,
    professionLabel: safeLabel(single(parameters.professionLabel), 120),
    serviceCode:
      serviceCode !== null &&
      /^SERV:[A-Z0-9][A-Z0-9_]{1,62}$/u.test(serviceCode)
        ? serviceCode
        : null,
    sort:
      sort === "BEST_RATED" ||
      (sort === "NEAREST" && validMunicipalityCode !== null)
        ? sort
        : "RECOMMENDED",
  });
}

export function parsePublicSearchContext(
  parameters: Readonly<Record<string, string | readonly string[] | undefined>>,
): {
  readonly jobId?: string;
  readonly jobRequestId?: string;
  readonly searchParameters: Readonly<
    Record<string, string | readonly string[] | undefined>
  >;
} {
  const rawJobRequestId = parameters.jobRequestId;
  const rawJobId = parameters.jobId;
  const jobRequestId =
    rawJobId === undefined &&
    typeof rawJobRequestId === "string" &&
    uuid.test(rawJobRequestId)
      ? rawJobRequestId
      : undefined;
  const jobId =
    rawJobRequestId === undefined &&
    typeof rawJobId === "string" &&
    uuid.test(rawJobId)
      ? rawJobId
      : undefined;
  const searchParameters = Object.fromEntries(
    Object.entries(parameters).filter(([key]) => publicSearchKeys.has(key)),
  );
  return {
    ...(jobRequestId === undefined ? {} : { jobRequestId }),
    ...(jobId === undefined ? {} : { jobId }),
    searchParameters,
  };
}

function single(value: string | readonly string[] | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function safeLabel(value: string | null, maximum: number): string {
  return value !== null &&
    value === value.trim() &&
    value.length <= maximum &&
    !/[\r\n\p{Cc}]/u.test(value)
    ? value
    : "";
}

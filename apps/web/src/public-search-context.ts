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
  "skillCodes",
  "sort",
  "specializationCode",
  "startsAt",
]);

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

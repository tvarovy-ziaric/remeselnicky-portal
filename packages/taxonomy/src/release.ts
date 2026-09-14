import { createHash } from "node:crypto";

import {
  CAPABILITY_LEVELS,
  TAXONOMY_ALIAS_KINDS,
  TAXONOMY_CONTENT_CLASSES,
  TAXONOMY_ENTRY_STATES,
  TAXONOMY_REVIEW_STATES,
  type PreparedProfessionTaxonomyRelease,
  type ProfessionTaxonomyReleaseSeed,
} from "./model.js";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const code = /^(?:PROF|SPEC|CAP|TEST):[A-Z0-9][A-Z0-9_]{1,62}$/u;
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const reviewReference = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{7,199}$/u;

export function prepareProfessionTaxonomyRelease(
  input: ProfessionTaxonomyReleaseSeed,
): PreparedProfessionTaxonomyRelease {
  validateReleaseHeader(input);
  const professions = sortedCopies(input.professions, "profession", (entry) => {
    validateEntry(entry, "profession");
  });
  const professionCodes = new Set(professions.map(({ code }) => code));
  const professionSlugs = uniqueSlugs(professions, "profession");
  validateReplacements(professions, professionCodes, "profession");
  validateNoReplacementCycle(professions, "profession");

  const specializations = sortedCopies(
    input.specializations,
    "specialization",
    (entry) => {
      validateEntry(entry, "specialization");
      if (!professionCodes.has(entry.professionCode)) {
        throw new TypeError("Specialization references an unknown profession.");
      }
    },
  );
  const specializationCodes = new Set(specializations.map(({ code }) => code));
  const specializationSlugs = uniqueSlugs(specializations, "specialization");
  validateReplacements(specializations, specializationCodes, "specialization");
  validateNoReplacementCycle(specializations, "specialization");

  const capabilityCriteria = sortedCopies(
    input.capabilityCriteria,
    "capability criterion",
    (entry) => {
      validateCodeAndLabel(entry.code, entry.labelSk);
      if (!professionCodes.has(entry.professionCode)) {
        throw new TypeError(
          "Capability criterion references an unknown profession.",
        );
      }
      if (!CAPABILITY_LEVELS.includes(entry.level)) {
        throw new TypeError("Capability criterion level is invalid.");
      }
      if (!TAXONOMY_ENTRY_STATES.includes(entry.state)) {
        throw new TypeError("Capability criterion state is invalid.");
      }
      validateText(entry.descriptionSk, 8, 500, "criterion description");
    },
  );

  const canonicalSlugs = new Set([...professionSlugs, ...specializationSlugs]);
  const aliases = sortedCopies(
    input.aliases,
    "alias",
    (entry) => {
      if (
        !TAXONOMY_ALIAS_KINDS.includes(entry.kind) ||
        !slug.test(entry.alias)
      ) {
        throw new TypeError("Taxonomy alias is invalid.");
      }
      if (canonicalSlugs.has(entry.alias)) {
        throw new TypeError("Taxonomy alias conflicts with a canonical slug.");
      }
      const targets =
        entry.targetKind === "PROFESSION"
          ? professionCodes
          : entry.targetKind === "SPECIALIZATION"
            ? specializationCodes
            : undefined;
      if (targets === undefined || !targets.has(entry.targetCode)) {
        throw new TypeError("Taxonomy alias target is invalid.");
      }
    },
    (entry) => `${entry.kind}:${entry.alias}`,
  );

  const release = {
    aliases,
    capabilityCriteria,
    contentClass: input.contentClass,
    professions,
    releaseId: input.releaseId,
    reviewReference: input.reviewReference,
    reviewState: input.reviewState,
    specializations,
    supersedesReleaseId: input.supersedesReleaseId,
    version: input.version,
  } satisfies ProfessionTaxonomyReleaseSeed;
  const checksumSha256 = createHash("sha256")
    .update(JSON.stringify(release), "utf8")
    .digest("hex");
  return deepFreeze({ ...release, checksumSha256 });
}

function validateReleaseHeader(input: ProfessionTaxonomyReleaseSeed): void {
  if (
    !uuid.test(input.releaseId) ||
    !Number.isSafeInteger(input.version) ||
    input.version < 1
  ) {
    throw new TypeError("Taxonomy release identity/version is invalid.");
  }
  if (
    (input.version === 1) !== (input.supersedesReleaseId === null) ||
    (input.supersedesReleaseId !== null &&
      (!uuid.test(input.supersedesReleaseId) ||
        input.supersedesReleaseId === input.releaseId))
  ) {
    throw new TypeError("Taxonomy release supersession chain is invalid.");
  }
  if (
    !TAXONOMY_CONTENT_CLASSES.includes(input.contentClass) ||
    !TAXONOMY_REVIEW_STATES.includes(input.reviewState)
  ) {
    throw new TypeError("Taxonomy governance state is invalid.");
  }
  const approved = input.reviewState === "HUMAN_REVIEW_APPROVED";
  if (
    input.contentClass === "PLACEHOLDER"
      ? approved || input.reviewReference !== null
      : !approved ||
        input.reviewReference === null ||
        !reviewReference.test(input.reviewReference)
  ) {
    throw new TypeError("Taxonomy content/review governance is inconsistent.");
  }
  if (input.professions.length === 0 || input.professions.length > 500) {
    throw new TypeError("Taxonomy release must contain bounded professions.");
  }
}

function validateEntry(
  entry: {
    readonly code: string;
    readonly labelSk: string;
    readonly replacedByCode: string | null;
    readonly slug: string;
    readonly state: string;
  },
  label: string,
): void {
  validateCodeAndLabel(entry.code, entry.labelSk);
  if (!slug.test(entry.slug) || entry.slug.length > 100) {
    throw new TypeError(`${label} slug is invalid.`);
  }
  if (!TAXONOMY_ENTRY_STATES.includes(entry.state as never)) {
    throw new TypeError(`${label} state is invalid.`);
  }
  if ((entry.state === "ACTIVE") !== (entry.replacedByCode === null)) {
    throw new TypeError(`${label} replacement is inconsistent with its state.`);
  }
}

function validateCodeAndLabel(candidateCode: string, labelSk: string): void {
  if (!code.test(candidateCode))
    throw new TypeError("Taxonomy code is invalid.");
  validateText(labelSk, 2, 120, "Slovak label");
}

function validateText(
  value: string,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (
    value !== value.trim() ||
    value.length < minimum ||
    value.length > maximum ||
    /[\r\n]/u.test(value)
  ) {
    throw new TypeError(`Taxonomy ${label} is invalid.`);
  }
}

function validateReplacements(
  values: readonly {
    readonly code: string;
    readonly replacedByCode: string | null;
  }[],
  codes: ReadonlySet<string>,
  label: string,
): void {
  for (const entry of values) {
    if (
      entry.replacedByCode !== null &&
      (!codes.has(entry.replacedByCode) || entry.replacedByCode === entry.code)
    ) {
      throw new TypeError(`${label} replacement target is invalid.`);
    }
  }
}

function validateNoReplacementCycle(
  values: readonly {
    readonly code: string;
    readonly replacedByCode: string | null;
  }[],
  label: string,
): void {
  const replacements = new Map(
    values.map(({ code, replacedByCode }) => [code, replacedByCode]),
  );
  for (const { code } of values) {
    const visited = new Set<string>();
    let current: string | null = code;
    while (current !== null) {
      if (visited.has(current)) {
        throw new TypeError(`${label} replacement cycle is forbidden.`);
      }
      visited.add(current);
      current = replacements.get(current) ?? null;
    }
  }
}

function uniqueSlugs(
  values: readonly { readonly slug: string }[],
  label: string,
): ReadonlySet<string> {
  const slugs = new Set<string>();
  for (const entry of values) {
    if (slugs.has(entry.slug)) throw new TypeError(`Duplicate ${label} slug.`);
    slugs.add(entry.slug);
  }
  return slugs;
}

function sortedCopies<T>(
  values: readonly T[],
  label: string,
  validate: (value: T) => void,
  key: (value: T) => string = (value) => (value as { code: string }).code,
): readonly Readonly<T>[] {
  const keys = new Set<string>();
  const result = values.map((value) => {
    validate(value);
    const candidate = key(value);
    if (keys.has(candidate))
      throw new TypeError(`Duplicate ${label} identifier.`);
    keys.add(candidate);
    return Object.freeze({ ...value });
  });
  return Object.freeze(
    result.sort((left, right) => key(left).localeCompare(key(right))),
  );
}

function deepFreeze<
  T extends ProfessionTaxonomyReleaseSeed & { checksumSha256: string },
>(value: T): T {
  return Object.freeze(value);
}

import type {
  ProfessionTaxonomyPersistence,
  ProfessionTaxonomyReleaseSeed,
  TaxonomyActivationInput,
} from "./model.js";
import { prepareProfessionTaxonomyRelease } from "./release.js";

export function createProfessionTaxonomyService(input: {
  readonly persistence: ProfessionTaxonomyPersistence;
}) {
  return Object.freeze({
    activateRelease(activation: TaxonomyActivationInput): Promise<boolean> {
      validateActivation(activation);
      return input.persistence.activateRelease(activation);
    },
    installRelease(release: ProfessionTaxonomyReleaseSeed) {
      return input.persistence.installRelease(
        prepareProfessionTaxonomyRelease(release),
      );
    },
    listCurrentProfessions() {
      return input.persistence.listCurrentProfessions();
    },
  });
}

function validateActivation(input: TaxonomyActivationInput): void {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  const reference = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{7,199}$/u;
  if (
    !uuid.test(input.activationId) ||
    !uuid.test(input.releaseId) ||
    (input.previousReleaseId !== null && !uuid.test(input.previousReleaseId)) ||
    !reference.test(input.actorReference) ||
    !reference.test(input.reviewReference)
  ) {
    throw new TypeError("Taxonomy activation input is invalid.");
  }
}

import type { ProfessionTaxonomyReleaseSeed } from "./model.js";
import { prepareProfessionTaxonomyRelease } from "./release.js";

/**
 * Technical seed only. These labels are deliberately synthetic and may never
 * become the public/current taxonomy without a separately reviewed release.
 */
export const PLACEHOLDER_ALPHA_TAXONOMY = prepareProfessionTaxonomyRelease({
  aliases: [],
  capabilityCriteria: [
    {
      code: "TEST:CAPABILITY_A",
      descriptionSk: "Syntetické kritérium na overenie technického modelu.",
      labelSk: "Syntetická schopnosť A",
      level: "ADVANCED",
      professionCode: "TEST:PROFESSION_A",
      state: "ACTIVE",
    },
  ],
  contentClass: "PLACEHOLDER",
  professions: [
    {
      code: "TEST:PROFESSION_A",
      labelSk: "Syntetické remeslo A",
      replacedByCode: null,
      slug: "synteticke-remeslo-a",
      state: "ACTIVE",
    },
    {
      code: "TEST:PROFESSION_B",
      labelSk: "Syntetické remeslo B",
      replacedByCode: null,
      slug: "synteticke-remeslo-b",
      state: "ACTIVE",
    },
  ],
  releaseId: "00000000-0000-4000-8000-000000001301",
  reviewReference: null,
  reviewState: "HUMAN_REVIEW_PENDING",
  specializations: [
    {
      code: "TEST:SPECIALIZATION_A",
      labelSk: "Syntetická špecializácia A",
      professionCode: "TEST:PROFESSION_A",
      replacedByCode: null,
      slug: "synteticka-specializacia-a",
      state: "ACTIVE",
    },
  ],
  supersedesReleaseId: null,
  version: 1,
} satisfies ProfessionTaxonomyReleaseSeed);

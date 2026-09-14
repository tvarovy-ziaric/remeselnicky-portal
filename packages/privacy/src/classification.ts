import type { DataClassification } from "./model.js";

export interface DataFieldClassification {
  readonly classification: DataClassification;
  readonly field: string;
  readonly purposeCode: string;
  readonly publicProjection: boolean;
}

const taxonomyPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const maxFieldCodeLength = 64;
const maxPurposeCodeLength = 96;

/** Default classification is PRIVATE; public exposure must be explicit. */
export function defineDataFieldClassification(input: {
  readonly classification?: DataClassification;
  readonly field: string;
  readonly purposeCode: string;
  readonly publicProjection?: boolean;
}): DataFieldClassification {
  if (
    input.field.length > maxFieldCodeLength ||
    input.purposeCode.length > maxPurposeCodeLength ||
    !taxonomyPattern.test(input.field) ||
    !taxonomyPattern.test(input.purposeCode)
  ) {
    throw new Error("Data classification requires bounded taxonomy codes");
  }
  const classification = input.classification ?? "PRIVATE";
  const publicProjection = input.publicProjection ?? false;
  if ((classification === "PUBLIC") !== publicProjection) {
    throw new Error(
      "PUBLIC classification and explicit public projection must agree",
    );
  }
  return Object.freeze({
    classification,
    field: input.field,
    publicProjection,
    purposeCode: input.purposeCode,
  });
}

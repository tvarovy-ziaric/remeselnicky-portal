import { platformContract } from "@portal/contracts";

export const appInfo = {
  apiVersion: platformContract.apiVersion,
  description: "Pozvánková alfa remeselníckeho portálu",
  name: "Remeselnícky portál",
} as const;

export { buildApi } from "./app.js";
export {
  PUBLIC_CRAFTSMAN_PROFILE_PATH,
  registerPublicCraftsmanProfileRoutes,
} from "./public-craftsman-profile/routes.js";
export type { PublicCraftsmanProfileRouteDependencies } from "./public-craftsman-profile/routes.js";
export { registerPublicPortfolioMediaRoutes } from "./public-portfolio-media/routes.js";
export type { PublicPortfolioMediaRouteDependencies } from "./public-portfolio-media/routes.js";
export {
  registerTaxonomyAutocompleteRoutes,
  TAXONOMY_AUTOCOMPLETE_PATH,
} from "./taxonomy-autocomplete/routes.js";
export type { TaxonomyAutocompleteRouteDependencies } from "./taxonomy-autocomplete/routes.js";

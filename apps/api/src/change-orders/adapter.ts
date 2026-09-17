import type { createChangeOrderRepository, ChangeOrderTerms } from "@portal/db";

import type { ChangeOrderRouteDependencies } from "./routes.js";

type Repository = ReturnType<typeof createChangeOrderRepository>;
type Transport = ChangeOrderRouteDependencies["changeOrders"];

function safeTerms(terms: ChangeOrderTerms, readyPdf: boolean) {
  const { externalPdfMediaAssetId: _privateAssetId, ...visible } = terms;
  return {
    ...visible,
    externalPdfDownloadPath:
      readyPdf && _privateAssetId !== undefined && _privateAssetId !== null
        ? `/v1/media/${_privateAssetId}/download`
        : null,
  };
}

function safeRevision(
  revision: NonNullable<Awaited<ReturnType<Repository["getRevision"]>>>,
  documentDownloadsEnabled: boolean,
) {
  const { authoredByUserId: _authorId, terms, ...visible } = revision;
  void _authorId;
  return {
    ...visible,
    terms: safeTerms(
      terms,
      documentDownloadsEnabled && revision.pdfContentSha256 !== null,
    ),
  };
}

export function createChangeOrderRouteAdapter(
  repository: Repository,
  options: { readonly documentDownloadsEnabled: boolean },
): Transport {
  return Object.freeze({
    async list(input) {
      const page = await repository.listChangeOrders({
        actorUserId: input.actorUserId,
        jobId: input.jobId,
        limit: input.limit,
        ...(input.cursor === undefined || input.cursor === null
          ? {}
          : {
              cursor: {
                createdAt: new Date(input.cursor.createdAt),
                changeOrderId: input.cursor.changeOrderId,
              },
            }),
      });
      return page === null
        ? null
        : {
            items: page.items,
            nextCursor:
              page.nextCursor === null
                ? null
                : {
                    createdAt: page.nextCursor.createdAt.toISOString(),
                    changeOrderId: page.nextCursor.changeOrderId,
                  },
          };
    },
    async get(input) {
      const detail = await repository.getChangeOrder(input);
      if (detail === null) return null;
      const {
        createdByUserId: _creatorId,
        actions,
        revisions,
        ...visible
      } = detail;
      void _creatorId;
      return {
        ...visible,
        revisions: revisions.map((revision) =>
          safeRevision(revision, options.documentDownloadsEnabled),
        ),
        actions: actions.map(({ actorUserId: _actorId, ...action }) => {
          void _actorId;
          return action;
        }),
      };
    },
    async listRevisions(input) {
      const page = await repository.listRevisions(input);
      return page === null
        ? null
        : {
            items: page.items.map((revision) =>
              safeRevision(revision, options.documentDownloadsEnabled),
            ),
            nextCursor: page.nextCursor,
          };
    },
    async getRevision(input) {
      const revision = await repository.getRevision(input);
      return revision === null
        ? null
        : safeRevision(revision, options.documentDownloadsEnabled);
    },
    create: (input) => repository.createDraft(input),
    replace: (input) => repository.replaceDraft(input),
    counterpropose: (input) => repository.counterpropose(input),
    propose: (input) => repository.submitRevision(input),
    approve: (input) => repository.approveRevision(input),
    reject: (input) => repository.rejectRevision(input),
    withdraw: (input) => repository.withdrawRevision(input),
  });
}

import { prisma } from "@linkwarden/prisma";
import { createFolder } from "@linkwarden/filesystem";
import { hasPassedLimit } from "@linkwarden/lib/verifyCapacity";
import type { MigrationTarget } from "@linkwarden/types/global";
import setCollection from "@/lib/api/setCollection";
import { extractUrlsFromText } from "./extractUrls";

// Sentinel error used to distinguish a quota-exceeded rollback (→ HTTP
// 400, user-facing message) from a genuine internal failure (→ HTTP
// 500). Thrown from inside the `$transaction` so Prisma rolls back any
// partial inserts, then re-caught by the outer try/catch.
class QuotaExceededError extends Error {}

const MAX_URL_LENGTH = 2047;
const MAX_TAG_LENGTH = 50;
// Hard cap on URLs per paste. The 10 MB body limit alone permits ~100 k
// short URLs, which would dominate a single transaction for minutes. This
// cap keeps a pathological paste bounded; users with genuinely larger
// lists should split them or use the file-based importers.
const MAX_URLS_PER_IMPORT = 5_000;
const DEFAULT_COLLECTION_NAME = "Imports";
// 60 s instead of 30 s so we have headroom at the MAX_URLS_PER_IMPORT cap
// (≈12 ms per row budget). The switch to bulk `createMany` on the no-tag
// path makes the common case dramatically faster; the tag path is still
// O(L) individual creates but avoids the O(L×T) connectOrCreate it
// replaced.
const IMPORT_TRANSACTION_TIMEOUT_MS = 60_000;
// Chunk size for `createMany`. Prisma caps parameter binding around 65 k;
// 500 rows × a handful of columns stays well under and lets the DB
// interleave other work.
const LINK_CREATE_CHUNK_SIZE = 500;

const normalizeTags = (tags: MigrationTarget["tags"]): string[] => {
  if (!tags || tags.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const trimmed = tag.trim().slice(0, MAX_TAG_LENGTH);
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
};

// Resolve every tag name to a concrete id exactly once per import, outside
// the write transaction. Safe because Tag has `@@unique([name, ownerId])`,
// so `createMany({skipDuplicates})` is idempotent, and a trailing
// `findMany` reads back every id deterministically. Keeps the transaction
// focused on link writes and cuts total DB round-trips from O(L×T) (the
// old per-link `connectOrCreate`) to O(T) for the resolve step.
async function resolveTagIds(
  userId: number,
  tagNames: string[]
): Promise<number[]> {
  if (tagNames.length === 0) return [];
  await prisma.tag.createMany({
    data: tagNames.map((name) => ({ name, ownerId: userId })),
    skipDuplicates: true,
  });
  const rows = await prisma.tag.findMany({
    where: { ownerId: userId, name: { in: tagNames } },
    select: { id: true },
  });
  // Guard against a TOCTOU window where a concurrent session deletes a
  // tag row between the createMany above and this findMany. If the id
  // count doesn't line up 1:1 with the requested names, refuse to
  // continue with a partially-tagged import rather than silently attach
  // fewer tags than the caller asked for.
  if (rows.length !== tagNames.length) {
    throw new Error(
      `Tag set changed concurrently during import (${rows.length}/${tagNames.length} resolved). Retry the import.`
    );
  }
  return rows.map((r) => r.id);
}

export default async function importFromText(
  userId: number,
  rawData: string,
  target?: MigrationTarget
) {
  const urls = extractUrlsFromText(rawData);

  if (urls.length === 0) {
    return {
      response:
        "No valid URLs were found in the provided text. Paste one URL per line.",
      status: 400,
    };
  }

  if (urls.length > MAX_URLS_PER_IMPORT) {
    return {
      response: `Too many URLs (${urls.length}). Please import at most ${MAX_URLS_PER_IMPORT} at a time.`,
      status: 413,
    };
  }

  const hasTooManyLinks = await hasPassedLimit(userId, urls.length);
  if (hasTooManyLinks) {
    return {
      response: `Your subscription has reached the maximum number of links allowed.`,
      status: 400,
    };
  }

  // Delegate to the canonical setCollection helper rather than
  // reimplementing find-or-create + ownership. This brings three things
  // the previous resolveCollectionId was missing:
  //   1. `canCreate` permission check for collections the user is a
  //      *member* of (not just owner of), via getPermission().
  //   2. push onto `user.collectionOrder` when a collection is created
  //      (so new paste-imports show up in the sidebar order).
  //   3. a single source of truth — once the advisory-lock upsert lands
  //      in setCollection, the import race is fixed here for free.
  const desiredName =
    target?.collectionName?.trim().slice(0, 254) || DEFAULT_COLLECTION_NAME;
  const collection = await setCollection({
    userId,
    collectionId: target?.collectionId,
    // Only pass collectionName when there's no id — setCollection treats
    // id-with-name as "use id, ignore name", but passing both is noise.
    collectionName: target?.collectionId ? undefined : desiredName,
  });

  if (!collection) {
    return {
      response: "Collection not found or you don't have permission to use it.",
      status: 400,
    };
  }

  // setCollection doesn't touch the filesystem; mirror the pattern the
  // other importers use. `createFolder` is idempotent so calling it for
  // an existing collection is a no-op.
  createFolder({ filePath: `archives/${collection.id}` });

  const collectionId = collection.id;
  const tagNames = normalizeTags(target?.tags);

  // Atomicity note: `createFolder` above and `resolveTagIds` below both
  // run *outside* the `$transaction` that writes links. If the link
  // transaction fails we therefore leave behind:
  //   • an empty `archives/<collectionId>/` directory, and
  //   • any newly-created `Tag` rows.
  // Both are intentionally tolerated because both operations are
  // idempotent on retry:
  //   • `createFolder` is effectively `mkdir -p` — a second call is a
  //     no-op.
  //   • `Tag` has `@@unique([name, ownerId])`, so the next run's
  //     `tag.createMany({skipDuplicates:true})` either re-discovers
  //     the existing rows or inserts only genuinely-missing ones.
  // Wrapping tag creation inside the `$transaction` would make this
  // strictly atomic but extend the transaction lifetime for a benefit
  // the retry path already provides. If strict atomicity ever becomes
  // a requirement (e.g. because tag visibility side-effects exist),
  // thread `tx` through `resolveTagIds` and move the call inside.
  //
  // Wrap every DB-touching operation from tag-resolve onward in a try so
  // a Prisma failure (transaction timeout, advisory-lock failure, a
  // concurrent tag delete hitting the TOCTOU guard, or a
  // `QuotaExceededError` from the under-the-lock quota recount) returns
  // an appropriate status rather than bubbling the rejection up to the
  // migration route handler and silently returning an empty 200.
  try {
    const tagIds = await resolveTagIds(userId, tagNames);
    const tagConnect = tagIds.map((id) => ({ id }));

    // `extractUrlsFromText` already returns a de-duplicated list (it
    // maintains an internal Set), so no second-pass dedup is needed here.

    await prisma.$transaction(
      async (tx) => {
        // Serialize same-user concurrent imports so two paste-imports of
        // up to `MAX_URLS_PER_IMPORT` URLs don't both slip past the
        // pre-transaction `hasPassedLimit` check and overrun the plan
        // quota. The one-arg `bigint` form of `pg_advisory_xact_lock`
        // lives in a different namespace from `setCollection`'s two-arg
        // `(int, int)` form, so this cannot deadlock or collide with the
        // collection find-or-create lock also in play on this request.
        // Auto-releases on commit/rollback — no cleanup required.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${userId}::bigint)`;

        // Recount under the lock. By the time we get here, any prior
        // holder's inserts are committed and visible to `link.count`, so
        // this check is race-safe. Throw `QuotaExceededError` to roll
        // back before any inserts run; the outer catch maps it to a 400.
        const overLimitNow = await hasPassedLimit(userId, urls.length);
        if (overLimitNow) {
          throw new QuotaExceededError(
            `Your subscription has reached the maximum number of links allowed.`
          );
        }

        if (tagIds.length === 0) {
          // Fast path — bulk-insert links. `createMany` is one query per
          // chunk regardless of size. Default `skipDuplicates: false`
          // matches existing importer behaviour (duplicates are permitted;
          // there is no @@unique on (collectionId, url)).
          for (let i = 0; i < urls.length; i += LINK_CREATE_CHUNK_SIZE) {
            const chunk = urls.slice(i, i + LINK_CREATE_CHUNK_SIZE);
            await tx.link.createMany({
              data: chunk.map((url) => ({
                url: url.slice(0, MAX_URL_LENGTH),
                name: "",
                collectionId,
                createdById: userId,
              })),
            });
          }
          return;
        }

        // Tag path — Prisma `createMany` doesn't support nested relation
        // writes, so we fall back to per-link create with pre-resolved
        // `tags.connect`. Still O(L) queries, but each is a single cheap
        // INSERT + implicit-M2M row; no per-tag `connectOrCreate`
        // round-trips. At 5 000 URLs × 50 tags this is ~5 000 queries
        // rather than ~250 000.
        for (const url of urls) {
          await tx.link.create({
            data: {
              url: url.slice(0, MAX_URL_LENGTH),
              name: "",
              collection: { connect: { id: collectionId } },
              createdBy: { connect: { id: userId } },
              tags: { connect: tagConnect },
            },
          });
        }
      },
      { timeout: IMPORT_TRANSACTION_TIMEOUT_MS }
    );
  } catch (error) {
    // Quota-exceeded rolls back the transaction with the user-facing
    // message; surface it as a 400 rather than a generic 500 so the
    // client can distinguish "fix your subscription" from "retry this".
    if (error instanceof QuotaExceededError) {
      return {
        response: error.message,
        status: 400,
      };
    }
    const message =
      error instanceof Error ? error.message : "Unknown import error.";
    return {
      response: `Failed to import URLs: ${message}`,
      status: 500,
    };
  }

  return {
    response: `Imported ${urls.length} link${urls.length === 1 ? "" : "s"}.`,
    status: 200,
  };
}

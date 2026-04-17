import { prisma } from "@linkwarden/prisma";
import getPermission from "./getPermission";
import { UsersAndCollections } from "@linkwarden/prisma/client";

type SetCollectionInput = {
  userId: number;
  collectionId?: number;
  collectionName?: string;
};

/**
 * Race-safe find-or-create for a user's top-level collection by name.
 *
 * The previous implementation had two problems:
 *   1. For the "Unorganized" sentinel it did `findFirst → create` with no
 *      lock, so two concurrent calls for the same user could both miss
 *      the find and both create, producing duplicate top-level
 *      "Unorganized" rows.
 *   2. For any other name it *always* created a new collection, so a
 *      quick-add flow that typed "Reading" twice produced two "Reading"s.
 *
 * Both are fixed here by serialising on a Postgres transactional advisory
 * lock keyed on `(userId, hashtext(name))`. The lock auto-releases on
 * commit/rollback, so no cleanup is required. Cheaper than a unique
 * constraint — no schema migration, no deploy-time risk of migration
 * failure on installs that already contain duplicates, and still correct
 * under concurrent load.
 *
 * Only Postgres is supported (matches the `datasource db.provider =
 * "postgresql"` in `packages/prisma/schema.prisma` and the docker-compose
 * default of `postgres:16-alpine`).
 */
async function findOrCreateTopLevelCollection(params: {
  userId: number;
  name: string;
}) {
  const { userId, name } = params;
  return await prisma.$transaction(async (tx) => {
    // Two-arg advisory lock: first key is the user id exactly (perfect
    // tenant isolation), second is a 32-bit hash of the collection name
    // (rare in-tenant collisions only).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${userId}::int, hashtext(${name}))`;

    const existing = await tx.collection.findFirst({
      where: { name, ownerId: userId, parentId: null },
    });
    if (existing) return existing;

    const created = await tx.collection.create({
      data: {
        name,
        ownerId: userId,
        createdById: userId,
      },
    });

    // Preserve the pre-refactor side effect — new collections are pushed
    // onto the user's sidebar order so they're not orphaned in the UI.
    await tx.user.update({
      where: { id: userId },
      data: {
        collectionOrder: {
          push: created.id,
        },
      },
    });

    return created;
  });
}

const setCollection = async ({
  userId,
  collectionId,
  collectionName,
}: SetCollectionInput) => {
  if (collectionId) {
    // Check if the collection exists
    const existingCollection = await prisma.collection.findUnique({
      where: { id: collectionId },
    });

    if (!existingCollection) return null;

    // Check if the user has access to the collection
    const collectionIsAccessible = await getPermission({
      userId,
      collectionId: existingCollection.id,
    });

    const memberHasAccess = collectionIsAccessible?.members.some(
      (e: UsersAndCollections) => e.userId === userId && e.canCreate
    );

    if (!(collectionIsAccessible?.ownerId === userId || memberHasAccess)) {
      return null;
    }

    return existingCollection;
  }

  // Name-based path: find-or-create under an advisory lock. Both the
  // "Unorganized" sentinel and arbitrary names go through the same
  // race-safe helper so that no call site ever produces a duplicate
  // top-level collection for the same user + name pair.
  const name = collectionName?.trim() || "Unorganized";
  return await findOrCreateTopLevelCollection({ userId, name });
};

export default setCollection;

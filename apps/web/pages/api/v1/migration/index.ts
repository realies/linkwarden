import type { NextApiRequest, NextApiResponse } from "next";
import exportData from "@/lib/api/controllers/migration/exportData";
import importFromHTMLFile from "@/lib/api/controllers/migration/importFromHTMLFile";
import importFromLinkwarden from "@/lib/api/controllers/migration/importFromLinkwarden";
import { MigrationFormat } from "@linkwarden/types/global";
import { MigrationRequestSchema } from "@linkwarden/lib/schemaValidation";
import verifyUser from "@/lib/api/verifyUser";
import importFromWallabag from "@/lib/api/controllers/migration/importFromWallabag";
import importFromOmnivore from "@/lib/api/controllers/migration/importFromOmnivore";
import importFromPocket from "@/lib/api/controllers/migration/importFromPocket";
import importFromText from "@/lib/api/controllers/migration/importFromText";

export const config = {
  api: {
    bodyParser: false,
  },
};

const parseJsonStream = (
  req: NextApiRequest,
  limitMb: number
): Promise<any> => {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;
    const limitBytes = limitMb * 1024 * 1024;

    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      totalLength += chunk.length;

      if (totalLength > limitBytes) {
        reject(new Error("Payload Too Large"));
      }
    });

    req.on("end", () => {
      try {
        const bodyString = Buffer.concat(chunks as any).toString("utf8");
        resolve(bodyString ? JSON.parse(bodyString) : {});
      } catch (error) {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", (err) => reject(err));
  });
};

export default async function users(req: NextApiRequest, res: NextApiResponse) {
  const user = await verifyUser({ req, res });
  if (!user) return;

  if (req.method === "GET") {
    const data = await exportData(user.id);

    if (data.status === 200)
      return res
        .setHeader("Content-Type", "application/json")
        .setHeader("Content-Disposition", "attachment; filename=backup.json")
        .status(data.status)
        .json(data.response);
  } else if (req.method === "POST") {
    if (process.env.NEXT_PUBLIC_DEMO === "true")
      return res.status(400).json({
        response:
          "This action is disabled because this is a read-only demo of Linkwarden.",
      });

    // Hoisted above the try so the 413 response reports the actually-
    // enforced MB cap (not the raw env var, which may be garbage the
    // runtime fell back from).
    const parsedLimit = parseInt(process.env.IMPORT_LIMIT ?? "", 10);
    // Guard against a non-numeric IMPORT_LIMIT env var. Previously a
    // garbage value produced `NaN * 1024 * 1024 === NaN`, which made the
    // `totalLength > limitBytes` check always false and effectively
    // disabled the body-size cap. Fall back to the 10 MB default instead.
    const limitMb =
      Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 10;

    let rawRequest: unknown;

    try {
      rawRequest = await parseJsonStream(req, limitMb);
    } catch (error: unknown) {
      if (error instanceof Error && error.message === "Payload Too Large") {
        return res.status(413).json({
          response: `Import file exceeds the ${limitMb}MB size limit.`,
        });
      }
      return res
        .status(400)
        .json({ response: "Invalid request body provided." });
    }

    const validation = MigrationRequestSchema.safeParse(rawRequest);
    if (!validation.success) {
      const first = validation.error.issues[0];
      const path = first?.path?.join(".") || "body";
      return res.status(400).json({
        response: `Invalid migration request: ${first?.message ?? "validation error"} [${path}]`,
      });
    }
    const request = validation.data;

    let data;
    if (request.format === MigrationFormat.htmlFile)
      data = await importFromHTMLFile(user.id, request.data);
    else if (request.format === MigrationFormat.linkwarden)
      data = await importFromLinkwarden(user.id, request.data);
    else if (request.format === MigrationFormat.wallabag)
      data = await importFromWallabag(user.id, request.data);
    else if (request.format === MigrationFormat.omnivore)
      data = await importFromOmnivore(user.id, request.data);
    else if (request.format === MigrationFormat.pocket)
      data = await importFromPocket(user.id, request.data);
    else if (request.format === MigrationFormat.text)
      data = await importFromText(user.id, request.data, request.target);
    else {
      // Exhaustiveness guard: if `MigrationFormat` ever grows a new value
      // and this dispatcher is not updated, `_exhaustive` becomes a type
      // error at compile time. At runtime we still return a clear 400
      // rather than falling through to a silent empty response.
      const _exhaustive: never = request.format;
      return res.status(400).json({
        response: `Unsupported migration format: ${String(_exhaustive)}`,
      });
    }

    if (data) return res.status(data.status).json({ response: data.response });
  }
}

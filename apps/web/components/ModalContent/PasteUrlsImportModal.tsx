import React, { useMemo, useState } from "react";
import Modal from "../Modal";
import { Button } from "@/components/ui/button";
import { Separator } from "../ui/separator";
import CollectionSelection from "@/components/InputSelect/CollectionSelection";
import TagSelection from "@/components/InputSelect/TagSelection";
import { useTranslation } from "next-i18next";
import toast from "react-hot-toast";
import { MigrationFormat } from "@linkwarden/types/global";
import type { MigrationRequestSchemaType } from "@linkwarden/lib/schemaValidation";

type Props = {
  onClose: () => void;
};

type CollectionValue = {
  id?: number;
  name: string;
};

// Narrowed shape of what react-select passes to our change handlers. We
// only read the fields listed here; keeping the type local means a
// misconfigured option silently drops into a default rather than flowing
// through as `any`.
type SelectOption = {
  value?: string | number;
  label?: string;
  // Creatable passes `__isNew__: true` when the user types a name that
  // isn't in the options list.
  __isNew__?: boolean;
};

export default function PasteUrlsImportModal({ onClose }: Props) {
  const { t } = useTranslation();

  const [text, setText] = useState("");
  const [collection, setCollection] = useState<CollectionValue>({
    name: "Imports",
  });
  const [tags, setTags] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Heuristic count for the UX — the server is still the source of truth.
  // Mirrors `extractUrlsFromText` exactly (whitespace-only tokenization,
  // trailing `,;` strip, wrapper-punctuation fallback, http(s)-only
  // allowlist) so the "N URLs detected" count matches the "Imported N
  // links" response the server returns.
  const candidateCount = useMemo(() => {
    if (!text.trim()) return 0;
    const seen = new Set<string>();
    let n = 0;
    for (const line of text.split(/\r?\n/)) {
      for (const rawToken of line.split(/\s+/)) {
        if (!rawToken.trim()) continue;
        const deTrailed = rawToken.trim().replace(/[,;]+$/, "");
        if (!deTrailed) continue;
        const candidates = [deTrailed];
        const stripped = rawToken
          .replace(/^[<("'\[]+|[>)"'\].,;:!?]+$/g, "")
          .trim();
        if (stripped && stripped !== deTrailed) candidates.push(stripped);
        let matched: string | null = null;
        for (const c of candidates) {
          let probe = c;
          if (/^www\./i.test(probe)) probe = `https://${probe}`;
          try {
            const parsed = new URL(probe);
            if (parsed.protocol === "http:" || parsed.protocol === "https:") {
              if (parsed.hostname.endsWith(".")) {
                parsed.hostname = parsed.hostname.slice(0, -1);
              }
              matched = parsed.toString();
              break;
            }
          } catch {
            // not a URL; try next candidate
          }
        }
        if (matched && !seen.has(matched)) {
          seen.add(matched);
          n++;
        }
      }
    }
    return n;
  }, [text]);

  const handleCollectionChange = (value: SelectOption | null) => {
    if (!value) {
      setCollection({ name: "Imports" });
      return;
    }
    // react-select creatable passes `__isNew__: true` when the user typed
    // a brand-new name; in that case `value.value` is the typed text.
    if (value.__isNew__) {
      const typed = String(value.value ?? value.label ?? "").trim();
      if (typed) setCollection({ name: typed });
      return;
    }
    const id = typeof value.value === "number" ? value.value : undefined;
    const name = typeof value.label === "string" ? value.label : "";
    setCollection({ id, name });
  };

  const handleTagsChange = (value: SelectOption[] | null) => {
    const list = Array.isArray(value) ? value : [];
    setTags(
      list
        .map((v) => (typeof v?.label === "string" ? v.label.trim() : ""))
        .filter((s) => s.length > 0)
    );
  };

  const submit = async () => {
    if (submitting) return;
    if (!text.trim()) {
      toast.error(t("paste_urls_empty_error"));
      return;
    }

    setSubmitting(true);
    const loading = toast.loading(t("importing"));

    const body: MigrationRequestSchemaType = {
      format: MigrationFormat.text,
      data: text,
      target: {
        collectionId: collection.id,
        collectionName: collection.id ? undefined : collection.name,
        tags,
      },
    };

    try {
      const response = await fetch("/api/v1/migration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      toast.dismiss(loading);

      if (!response.ok) {
        toast.error(payload?.response || t("paste_urls_generic_error"));
        setSubmitting(false);
        return;
      }

      toast.success(payload?.response || t("paste_urls_success"));
      onClose();
      // Let the success toast breathe before we refresh, since existing
      // importers follow the same pattern.
      setTimeout(() => {
        if (typeof window !== "undefined") window.location.reload();
      }, 1500);
    } catch (err) {
      // Surface the raw error to the browser console so dev/ops can
      // diagnose. The user-facing toast stays on the generic i18n string.
      console.error("Paste URL import failed:", err);
      toast.dismiss(loading);
      toast.error(t("paste_urls_generic_error"));
      setSubmitting(false);
    }
  };

  return (
    <Modal toggleModal={onClose}>
      <p className="text-xl font-thin">{t("paste_urls_title")}</p>
      <Separator className="my-3" />

      <div className="flex flex-col gap-4">
        <div>
          <p className="mb-2">{t("paste_urls_label")}</p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              "https://example.com/article-1\nhttps://example.com/article-2\nhttps://news.ycombinator.com/"
            }
            className="resize-y w-full h-48 rounded-md p-2 border-neutral-content bg-base-200 focus:border-primary border-solid border outline-none duration-100 text-sm font-mono"
            data-testid="paste-urls-textarea"
          />
          <p className="text-xs text-neutral mt-1">
            {candidateCount > 0
              ? t("paste_urls_count", { count: candidateCount })
              : t("paste_urls_hint")}
          </p>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <p className="mb-2">{t("collection")}</p>
            <CollectionSelection
              onChange={handleCollectionChange}
              defaultValue={{ value: undefined, label: collection.name }}
              creatable
            />
          </div>
          <div>
            <p className="mb-2">{t("tags")}</p>
            <TagSelection onChange={handleTagsChange} />
          </div>
        </div>
      </div>

      <div className="flex justify-end items-center mt-5">
        <Button
          variant="accent"
          onClick={submit}
          disabled={submitting || candidateCount === 0}
        >
          {submitting ? t("importing") : t("paste_urls_submit")}
        </Button>
      </div>
    </Modal>
  );
}

import { describe, expect, it, beforeEach } from "vitest";
import useLinkStore from "./links";

/**
 * Unit tests for the Zustand link-selection store.
 *
 * The store was extended with Shift+click range selection support; these
 * tests cover both the legacy single-toggle behaviour and the new
 * `selectRange` action, including the "anchor not in current page" fallback.
 */

const ordered = [10, 11, 12, 13, 14, 15];

beforeEach(() => {
  useLinkStore.getState().clearSelected();
});

describe("useLinkStore", () => {
  it("starts empty", () => {
    const state = useLinkStore.getState();
    expect(state.selectionCount).toBe(0);
    expect(state.lastSelectedId).toBeNull();
  });

  it("toggles a single link and tracks the anchor", () => {
    const { toggleSelected } = useLinkStore.getState();
    toggleSelected(11);
    let s = useLinkStore.getState();
    expect(s.isSelected(11)).toBe(true);
    expect(s.selectionCount).toBe(1);
    expect(s.lastSelectedId).toBe(11);

    toggleSelected(11);
    s = useLinkStore.getState();
    expect(s.isSelected(11)).toBe(false);
    expect(s.selectionCount).toBe(0);
    // Deselect does NOT move the anchor onto the just-removed item — the
    // anchor should track the most recent *added* selection. Since 11
    // was both the last-added and the just-removed id in this narrow
    // test, the observed value is still 11 (unchanged from the prior
    // select). The next test asserts the interesting case where the
    // prior anchor is a different id.
    expect(s.lastSelectedId).toBe(11);
  });

  it("preserves the anchor through a deselect of a later item", () => {
    const { toggleSelected } = useLinkStore.getState();
    toggleSelected(10); // anchor = 10
    toggleSelected(12); // anchor = 12
    toggleSelected(12); // deselect 12 — anchor must stay at 12 (the
    // most recent *added* selection), not revert back to 10 and not
    // reset to null. Previously this branch overwrote the anchor to
    // the removed id; the contract now is "only add moves the anchor".
    const s = useLinkStore.getState();
    expect(s.isSelected(10)).toBe(true);
    expect(s.isSelected(12)).toBe(false);
    expect(s.lastSelectedId).toBe(12);
  });

  it("selects a forward range inclusively", () => {
    const { toggleSelected, selectRange } = useLinkStore.getState();
    toggleSelected(11);
    selectRange(11, 14, ordered);
    const s = useLinkStore.getState();
    expect(s.selectionCount).toBe(4);
    for (const id of [11, 12, 13, 14]) {
      expect(s.isSelected(id)).toBe(true);
    }
    expect(s.isSelected(10)).toBe(false);
    expect(s.isSelected(15)).toBe(false);
    expect(s.lastSelectedId).toBe(14);
  });

  it("selects a reverse range inclusively", () => {
    const { toggleSelected, selectRange } = useLinkStore.getState();
    toggleSelected(14);
    selectRange(14, 11, ordered);
    const s = useLinkStore.getState();
    expect(s.selectionCount).toBe(4);
    for (const id of [11, 12, 13, 14]) {
      expect(s.isSelected(id)).toBe(true);
    }
    expect(s.lastSelectedId).toBe(11);
  });

  it("unions existing selection with the range", () => {
    const { toggleSelected, selectRange } = useLinkStore.getState();
    toggleSelected(15);
    toggleSelected(11);
    selectRange(11, 13, ordered);
    const s = useLinkStore.getState();
    // 15 was selected before the range and should remain selected.
    expect(s.isSelected(15)).toBe(true);
    for (const id of [11, 12, 13]) expect(s.isSelected(id)).toBe(true);
    expect(s.selectionCount).toBe(4);
  });

  it("falls back to a plain toggle when the anchor is off-page", () => {
    const { toggleSelected, selectRange } = useLinkStore.getState();
    toggleSelected(14);
    // 99 is not in `ordered`: emulates an anchor that was set on a page the
    // user has since scrolled away from. Implementation should degrade to a
    // single-item toggle on the click target rather than doing nothing.
    selectRange(99, 12, ordered);
    const s = useLinkStore.getState();
    expect(s.isSelected(12)).toBe(true);
    expect(s.selectionCount).toBe(2);
    expect(s.lastSelectedId).toBe(12);
  });

  it("preserves anchor when the off-page fallback deselects", () => {
    const { toggleSelected, selectRange } = useLinkStore.getState();
    toggleSelected(14); // anchor = 14, 14 is selected
    // First off-page-anchor shift-click on 12 adds it (anchor moves to 12).
    selectRange(99, 12, ordered);
    expect(useLinkStore.getState().lastSelectedId).toBe(12);
    // Second off-page-anchor shift-click on 12 deselects it. The anchor
    // must stay at 12 (the most recent *added* selection) rather than be
    // reset via the removed-id path — mirrors `toggleSelected`'s contract
    // that only an add advances the anchor.
    selectRange(99, 12, ordered);
    const s = useLinkStore.getState();
    expect(s.isSelected(12)).toBe(false);
    expect(s.isSelected(14)).toBe(true);
    expect(s.lastSelectedId).toBe(12);
  });

  it("setSelected replaces the selection and sets the anchor", () => {
    const { setSelected } = useLinkStore.getState();
    setSelected([10, 12, 15]);
    const s = useLinkStore.getState();
    expect(s.selectionCount).toBe(3);
    expect(s.isSelected(10)).toBe(true);
    expect(s.isSelected(12)).toBe(true);
    expect(s.isSelected(15)).toBe(true);
    expect(s.lastSelectedId).toBe(15);
  });

  it("clearSelected resets everything including the anchor", () => {
    const { toggleSelected, clearSelected } = useLinkStore.getState();
    toggleSelected(10);
    toggleSelected(11);
    clearSelected();
    const s = useLinkStore.getState();
    expect(s.selectionCount).toBe(0);
    expect(s.lastSelectedId).toBeNull();
  });
});

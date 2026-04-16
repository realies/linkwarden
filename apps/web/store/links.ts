import { create } from "zustand";

type LinkStore = {
  selectedIds: Record<number, true>;
  lastSelectedId: number | null;
  isSelected: (id: number) => boolean;
  toggleSelected: (id: number) => void;
  selectRange: (fromId: number, toId: number, orderedIds: number[]) => void;
  clearSelected: () => void;
  setSelected: (ids: number[]) => void;
  selectionCount: number;
};

const useLinkStore = create<LinkStore>()((set, get) => ({
  selectedIds: {},
  lastSelectedId: null,

  isSelected: (id) => !!get().selectedIds[id],

  toggleSelected: (id) =>
    set((state) => {
      const next = { ...state.selectedIds };

      if (next[id]) {
        // Deselect — keep the previous anchor rather than moving it onto
        // the item the user just removed. A shift-click after a deselect
        // should extend from the most recent *added* selection, not from
        // the item that was unchecked a moment ago.
        delete next[id];
        return {
          selectedIds: next,
          selectionCount: state.selectionCount - 1,
          lastSelectedId: state.lastSelectedId,
        };
      }
      next[id] = true;
      return {
        selectedIds: next,
        selectionCount: state.selectionCount + 1,
        lastSelectedId: id,
      };
    }),

  selectRange: (fromId, toId, orderedIds) =>
    set((state) => {
      const fromIndex = orderedIds.indexOf(fromId);
      const toIndex = orderedIds.indexOf(toId);

      // If either endpoint is not in the current ordered list (e.g. the
      // anchor was on a page that is no longer rendered), fall back to a
      // single-item toggle on `toId` so the interaction is never a no-op.
      // Mirror `toggleSelected`'s anchor-only-on-add contract: a deselect
      // preserves the previous anchor so a shift-click that follows still
      // extends from the most recent *added* selection.
      if (fromIndex === -1 || toIndex === -1) {
        const next = { ...state.selectedIds };
        if (next[toId]) {
          delete next[toId];
          return {
            selectedIds: next,
            selectionCount: state.selectionCount - 1,
            lastSelectedId: state.lastSelectedId,
          };
        }
        next[toId] = true;
        return {
          selectedIds: next,
          selectionCount: state.selectionCount + 1,
          lastSelectedId: toId,
        };
      }

      const [start, end] =
        fromIndex < toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex];
      const next = { ...state.selectedIds };
      for (let i = start; i <= end; i++) {
        next[orderedIds[i]] = true;
      }
      return {
        selectedIds: next,
        selectionCount: Object.keys(next).length,
        lastSelectedId: toId,
      };
    }),

  clearSelected: () =>
    set({ selectedIds: {}, selectionCount: 0, lastSelectedId: null }),

  setSelected: (ids) =>
    set(() => {
      const next: Record<number, true> = {};
      for (let i = 0; i < ids.length; i++) next[ids[i]] = true;
      return {
        selectedIds: next,
        selectionCount: Object.keys(next).length,
        lastSelectedId: ids.length > 0 ? ids[ids.length - 1] : null,
      };
    }),

  selectionCount: 0,
}));

export default useLinkStore;

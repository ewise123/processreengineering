import type { ChatTurn, UUID } from "@/lib/types";

/** The subset of the Web Storage API we use; injected so the store is
 * testable in the node test env and SSR-safe. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const keyFor = (versionId: UUID) => `poet-chat:${versionId}`;

export interface ChatSessionStore {
  load(versionId: UUID): ChatTurn[];
  save(versionId: UUID, turns: ChatTurn[]): void;
  clear(versionId: UUID): void;
}

/** Ephemeral chat history keyed by version id. Survives tab navigation
 * within the session; cleared on hard reload (sessionStorage). */
export function makeChatSessionStore(storage: StorageLike): ChatSessionStore {
  return {
    load(versionId) {
      const raw = storage.getItem(keyFor(versionId));
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as ChatTurn[]) : [];
      } catch {
        return [];
      }
    },
    save(versionId, turns) {
      storage.setItem(keyFor(versionId), JSON.stringify(turns));
    },
    clear(versionId) {
      storage.removeItem(keyFor(versionId));
    },
  };
}

/** Returns the browser sessionStorage-backed store, or a no-op store during
 * SSR / when storage is unavailable. */
export function browserChatSessionStore(): ChatSessionStore {
  if (typeof window === "undefined" || !window.sessionStorage) {
    const noop: StorageLike = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
    return makeChatSessionStore(noop);
  }
  return makeChatSessionStore(window.sessionStorage);
}

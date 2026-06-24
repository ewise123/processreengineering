import { describe, it, expect } from "vitest";
import { makeChatSessionStore } from "./chat-session";
import type { ChatTurn } from "@/lib/types";

function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

const TURNS: ChatTurn[] = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "hello [[node:abc]]" },
];

describe("makeChatSessionStore", () => {
  it("returns [] when nothing is stored", () => {
    const store = makeChatSessionStore(fakeStorage());
    expect(store.load("v1")).toEqual([]);
  });

  it("round-trips turns per version id", () => {
    const s = fakeStorage();
    const store = makeChatSessionStore(s);
    store.save("v1", TURNS);
    expect(store.load("v1")).toEqual(TURNS);
    expect(store.load("v2")).toEqual([]); // isolated per version
  });

  it("clear() empties a version's history", () => {
    const store = makeChatSessionStore(fakeStorage());
    store.save("v1", TURNS);
    store.clear("v1");
    expect(store.load("v1")).toEqual([]);
  });

  it("load() tolerates corrupt JSON by returning []", () => {
    const s = fakeStorage();
    s.setItem("poet-chat:v1", "{not json");
    const store = makeChatSessionStore(s);
    expect(store.load("v1")).toEqual([]);
  });
});

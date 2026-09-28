import { describe, expect, it } from "vitest";
import { makeWheelModeStore, WHEEL_MODE_KEY, type StorageLike } from "./wheel-mode";

function memory(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

describe("wheel mode store", () => {
  it("defaults to trackpad", () => {
    expect(makeWheelModeStore(memory()).load()).toBe("trackpad");
  });

  it("remembers mouse mode", () => {
    const m = memory();
    makeWheelModeStore(m).save("mouse");
    expect(m.data.get(WHEEL_MODE_KEY)).toBe("mouse");
    expect(makeWheelModeStore(m).load()).toBe("mouse");
  });

  it("treats an unknown stored value as trackpad", () => {
    const m = memory();
    m.data.set(WHEEL_MODE_KEY, "joystick");
    expect(makeWheelModeStore(m).load()).toBe("trackpad");
  });

  it("survives storage that throws", () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const store = makeWheelModeStore(broken);
    expect(store.load()).toBe("trackpad");
    expect(() => store.save("mouse")).not.toThrow();
  });
});

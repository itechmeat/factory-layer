import { describe, expect, test } from "bun:test";
import { authenticate, createUser, login, UserError } from "../src/domain/users.js";
import { createId, createStore } from "../src/store.js";

const valid = { email: "a@b.com", password: "password1", name: "Ann", role: "customer" };

function kindOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof UserError ? e.kind : "other";
  }
  return undefined;
}

describe("createUser", () => {
  test("creates a user without a password", () => {
    const u = createUser(createStore(), valid);
    expect(u).toEqual({ id: u.id, email: "a@b.com", name: "Ann", role: "customer" });
    expect(JSON.stringify(u)).not.toContain("password");
  });

  test.each([
    ["no at", { ...valid, email: "ab.com" }],
    ["no dot after at", { ...valid, email: "a.b@c" }],
    ["short password", { ...valid, password: "1234567" }],
    ["empty name", { ...valid, name: "" }],
    ["long name", { ...valid, name: "x".repeat(101) }],
    ["bad role", { ...valid, role: "admin" }],
    ["non-string email", { ...valid, email: 5 }],
    ["not an object", null],
  ])("rejects %s", (_n, body) => {
    expect(kindOf(() => createUser(createStore(), body))).toBe("validation");
  });

  test("accepts boundary name and password lengths", () => {
    const s = createStore();
    expect(
      createUser(s, { ...valid, name: "x".repeat(100), password: "12345678" }).name.length,
    ).toBe(100);
  });

  test("duplicate email differing in case is a conflict", () => {
    const s = createStore();
    createUser(s, valid);
    expect(kindOf(() => createUser(s, { ...valid, email: "A@B.COM" }))).toBe("conflict");
  });
});

describe("login", () => {
  test("issues a token resolving to the user", () => {
    const s = createStore();
    const u = createUser(s, valid);
    const r = login(s, { email: "A@b.com", password: "password1" });
    expect(r.user).toEqual(u);
    expect(JSON.stringify(r)).not.toContain("password1");
    expect(authenticate(s, r.token)).toEqual(u);
  });

  test("wrong password, unknown email and bad body are auth errors", () => {
    const s = createStore();
    createUser(s, valid);
    expect(kindOf(() => login(s, { email: "a@b.com", password: "nope" }))).toBe("auth");
    expect(kindOf(() => login(s, { email: "x@y.com", password: "password1" }))).toBe("auth");
    expect(kindOf(() => login(s, undefined))).toBe("auth");
  });

  test("unknown or missing tokens do not authenticate", () => {
    const s = createStore();
    expect(authenticate(s, "bogus")).toBeUndefined();
    expect(authenticate(s, undefined)).toBeUndefined();
  });
});

describe("createId", () => {
  test("returns unique strings", () => {
    expect(typeof createId()).toBe("string");
    expect(createId()).not.toBe(createId());
  });
});

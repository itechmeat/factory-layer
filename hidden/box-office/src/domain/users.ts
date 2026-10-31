import { createId, type Role, type Store, type StoredUser } from "../store.js";

export type UserErrorKind = "validation" | "conflict" | "auth";

export class UserError extends Error {
  readonly kind: UserErrorKind;
  constructor(kind: UserErrorKind, message: string) {
    super(message);
    this.name = "UserError";
    this.kind = kind;
  }
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface NewUser {
  email: string;
  password: string;
  name: string;
  role: Role;
}

function toPublic(user: StoredUser): PublicUser {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function validEmail(email: string): boolean {
  const at = email.indexOf("@");
  return at >= 0 && email.indexOf(".", at + 1) >= 0;
}

export function validateNewUser(input: unknown): NewUser {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new UserError("validation", "body must be an object");
  }
  const { email, password, name, role } = input as Record<string, unknown>;
  if (typeof email !== "string" || !validEmail(email)) {
    throw new UserError("validation", "email is invalid");
  }
  if (typeof password !== "string" || password.length < 8) {
    throw new UserError("validation", "password must be at least 8 characters");
  }
  if (typeof name !== "string" || name.length < 1 || name.length > 100) {
    throw new UserError("validation", "name must be 1-100 characters");
  }
  if (role !== "organizer" && role !== "customer") {
    throw new UserError("validation", "role must be organizer or customer");
  }
  return { email, password, name, role };
}

export function createUser(store: Store, input: unknown): PublicUser {
  const data = validateNewUser(input);
  const key = normalizeEmail(data.email);
  if (store.usersByEmail.has(key)) {
    throw new UserError("conflict", "email already registered");
  }
  const user: StoredUser = { id: createId(), ...data };
  store.users.set(user.id, user);
  store.usersByEmail.set(key, user.id);
  return toPublic(user);
}

export function login(store: Store, input: unknown): { token: string; user: PublicUser } {
  const { email, password } = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const id = typeof email === "string" ? store.usersByEmail.get(normalizeEmail(email)) : undefined;
  const user = id === undefined ? undefined : store.users.get(id);
  if (user === undefined || typeof password !== "string" || user.password !== password) {
    throw new UserError("auth", "invalid credentials");
  }
  const token = createId();
  store.tokens.set(token, user.id);
  return { token, user: toPublic(user) };
}

export function authenticate(store: Store, token: string | undefined): PublicUser | undefined {
  if (token === undefined) return undefined;
  const id = store.tokens.get(token);
  const user = id === undefined ? undefined : store.users.get(id);
  return user === undefined ? undefined : toPublic(user);
}

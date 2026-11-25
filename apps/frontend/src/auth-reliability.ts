import type { QueryClient } from "@tanstack/react-query";
import { ApiError, getApiErrorStatus } from "./api-client";

export const AUTH_USER_QUERY_KEY = ["auth-me"] as const;

export type AuthQueryState<T> =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "unavailable" }
  | { status: "authenticated"; user: T; verificationFailed: boolean };

type AuthQuerySnapshot<T> = {
  data: T | undefined;
  error: unknown;
  isError: boolean;
  isLoading: boolean;
};

export function resolveAuthQueryState<T>(query: AuthQuerySnapshot<T>): AuthQueryState<T> {
  if (query.isLoading && query.data === undefined) return { status: "loading" };
  if (getApiErrorStatus(query.error) === 401 && query.isError) return { status: "unauthenticated" };
  if (query.data !== undefined) {
    return { status: "authenticated", user: query.data, verificationFailed: query.isError };
  }
  if (query.isError) return { status: "unavailable" };
  return { status: "unavailable" };
}

export function authenticationErrorMessage(error: unknown, flow: "login" | "registration") {
  const status = getApiErrorStatus(error);
  if (flow === "login" && status === 401) return "Email or password is incorrect.";
  if (flow === "login" && status === 429) {
    const retryAfter = error instanceof ApiError ? error.retryAfterSeconds : undefined;
    return retryAfter
      ? `Too many sign-in attempts. Please wait ${retryAfter} seconds and try again.`
      : "Too many sign-in attempts. Please wait before trying again.";
  }
  if (flow === "login" && status === 403) {
    return error instanceof Error ? error.message : "This account cannot sign in.";
  }
  if (flow === "registration" && status === 409) {
    return error instanceof Error ? error.message : "An account with that email already exists.";
  }
  if (status === 408 || (status !== undefined && status >= 500)) {
    return flow === "login"
      ? "The sign-in service is temporarily unavailable. Please try again shortly."
      : "Account creation is temporarily unavailable. If you already submitted this form, try signing in before submitting again.";
  }
  if (error instanceof TypeError) {
    return flow === "login"
      ? "Could not reach the sign-in service. Check your connection and try again."
      : "Could not reach the account service. Check your connection, then try signing in before submitting again.";
  }
  return error instanceof Error ? error.message : "The request could not be completed.";
}

export async function runAuthSubmission<T>(
  lock: { current: boolean },
  submit: () => Promise<T>,
): Promise<{ started: false } | { started: true; value: T }> {
  if (lock.current) return { started: false };
  lock.current = true;
  try {
    return { started: true, value: await submit() };
  } finally {
    lock.current = false;
  }
}

function isPrivateAuthQuery(queryKey: readonly unknown[]) {
  const prefix = queryKey[0];
  return prefix === "auth-me" ||
    prefix === "inventory-history" ||
    (typeof prefix === "string" && prefix.startsWith("admin-"));
}

export function clearAuthenticatedQueryCache(queryClient: QueryClient) {
  queryClient.removeQueries({ predicate: query => isPrivateAuthQuery(query.queryKey) });
}

export function clearPrivateDataAfterUnauthorized(error: unknown, queryClient: QueryClient) {
  if (getApiErrorStatus(error) !== 401) return false;
  clearAuthenticatedQueryCache(queryClient);
  return true;
}

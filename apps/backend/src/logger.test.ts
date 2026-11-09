import { describe, expect, it, vi } from "vitest";
import { logger } from "./logger.js";

describe("structured error logging", () => {
  it("writes provider diagnostics without exposing secret-like values", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logger.error("Cloudinary image upload failed", undefined, {
      cloudinaryErrorMessage: "Invalid API key",
      cloudinaryErrorName: "Error",
      cloudinaryErrorCode: "401",
      cloudinaryErrorStatus: 401,
      attemptedSecret: "secret=do-not-log",
    });

    expect(output).toHaveBeenCalledOnce();
    const entry = JSON.parse(String(output.mock.calls[0][0])) as Record<string, unknown>;
    expect(entry.cloudinaryErrorMessage).toBe("Invalid API key");
    expect(entry.cloudinaryErrorName).toBe("Error");
    expect(entry.cloudinaryErrorCode).toBe("401");
    expect(entry.cloudinaryErrorStatus).toBe(401);
    expect(entry.attemptedSecret).toBe("secret=[redacted]");
    output.mockRestore();
  });
});

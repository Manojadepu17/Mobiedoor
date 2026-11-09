type LogFields = Record<string, string | number | boolean | undefined>;

function redact(value: string) {
  return value
    .replace(/mysql:\/\/[^\s]+/gi, "mysql://[redacted]")
    .replace(/(authorization|cookie|set-cookie|token|password|secret)=?[^\s,;]*/gi, "$1=[redacted]");
}

function write(level: "info" | "error", message: string, fields: LogFields = {}) {
  const safeFields = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, typeof value === "string" ? redact(value) : value]));
  const entry = { level, message: redact(message), ...safeFields, timestamp: new Date().toISOString() };
  (level === "error" ? console.error : console.log)(JSON.stringify(entry));
}

export const logger = {
  info(message: string, fields?: LogFields) {
    write("info", message, fields);
  },
  error(message: string, error?: unknown, fields: LogFields = {}) {
    const errorFields = error instanceof Error ? { errorName: error.name, errorMessage: redact(error.message) } : {};
    write("error", message, { ...fields, ...errorFields });
  },
};

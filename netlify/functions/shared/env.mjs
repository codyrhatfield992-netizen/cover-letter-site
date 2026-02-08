export function getEnv(name, fallback = "") {
  const value = Netlify.env.get(name);
  if (value === undefined || value === null || value === "") return fallback;
  return value;
}

export function assertRequiredEnv(names) {
  const missing = names.filter((name) => !getEnv(name));
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

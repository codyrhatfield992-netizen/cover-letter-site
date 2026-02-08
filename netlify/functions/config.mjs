import { getEnv } from "./shared/env.mjs";
import { jsonResponse } from "./shared/http.mjs";

export default async () => {
  const config = {
    supabaseUrl: getEnv("SUPABASE_URL"),
    supabaseAnonKey: getEnv("SUPABASE_ANON_KEY"),
  };

  return jsonResponse(200, config, { "Cache-Control": "public, max-age=300" });
};

export const config = {
  path: "/api/config",
};

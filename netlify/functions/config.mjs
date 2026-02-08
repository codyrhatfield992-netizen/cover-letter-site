export default async () => {
  const config = {
    supabaseUrl: process.env.SUPABASE_URL || "",
supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
  };

  return new Response(JSON.stringify(config), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
  });
};

export const config = {
  path: "/api/config",
};

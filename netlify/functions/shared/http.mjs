const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, stripe-signature",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

export function jsonResponse(status, payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...DEFAULT_HEADERS, ...extraHeaders },
  });
}

export function optionsResponse() {
  return new Response(null, {
    status: 204,
    headers: DEFAULT_HEADERS,
  });
}

import { getAuthenticatedUser, getSupabaseAdmin } from "./shared/supabase.mjs";
import pdfParse from "pdf-parse";

const SCANNED_THRESHOLD = 200;
const MAX_SUMMARY_CHARS = 900;

function computeHash(text) {
  // Simple hash using Web Crypto-compatible approach
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return "h" + Math.abs(hash).toString(36) + "_" + text.length;
}

function buildSummaryPrompt(resumeText) {
  return `You are a resume summarizer. Given the resume text below, produce a structured summary in EXACTLY this format. Do not invent details. Keep the total output under ${MAX_SUMMARY_CHARS} characters.

NAME:
TITLE:
CORE SKILLS:
EXPERIENCE (2-4 bullets):
EDUCATION:
LINKS (if present):

Resume text:
${resumeText}`;
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 1. Require authentication
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: "Not authenticated" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 2. Parse the multipart form data to get the PDF file
  let formData;
  try {
    formData = await req.formData();
  } catch (_) {
    return new Response(JSON.stringify({ error: "Invalid form data" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const file = formData.get("resume");
  if (!file || typeof file === "string") {
    return new Response(JSON.stringify({ error: "No PDF file provided" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 3. Extract text from PDF
  let extractedText;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const parsed = await pdfParse(buffer);
    extractedText = (parsed.text || "").trim();
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Failed to read PDF. Try a different file or paste your resume manually." }),
      { status: 422, headers: { "Content-Type": "application/json" } }
    );
  }

  // 4. Detect scanned/image PDFs
  if (extractedText.length < SCANNED_THRESHOLD) {
    return new Response(
      JSON.stringify({
        error: "scanned_pdf",
        message: "This looks like a scanned PDF. Upload a text-based PDF or paste your resume.",
      }),
      { status: 422, headers: { "Content-Type": "application/json" } }
    );
  }

  // 5. Compute hash and check for existing summary
  const resumeHash = computeHash(extractedText);
  const supabase = getSupabaseAdmin();

  const { data: profile } = await supabase
    .from("profiles")
    .select("resume_hash, resume_summary")
    .eq("id", user.id)
    .single();

  // If same hash exists, reuse the stored summary
  if (profile && profile.resume_hash === resumeHash && profile.resume_summary) {
    return new Response(
      JSON.stringify({
        summary: profile.resume_summary,
        cached: true,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // 6. Call AI to summarize the resume
  const backendUrl =
    Netlify.env.get("BACKEND_URL") ||
    "https://cover-letter-api-production-fe17.up.railway.app";

  let summary;
  try {
    const aiRes = await fetch(`${backendUrl}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobDescription: "Summarize this resume in structured format.",
        resume: extractedText,
        tone: "direct and professional",
        systemPrompt: buildSummaryPrompt(extractedText),
      }),
    });

    const aiData = await aiRes.json().catch(() => ({}));

    if (!aiRes.ok) {
      // Fallback: return the raw extracted text if AI fails
      return new Response(
        JSON.stringify({
          summary: extractedText.substring(0, MAX_SUMMARY_CHARS),
          raw: true,
          message: "AI summary unavailable. Raw text extracted instead.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    summary = (aiData.text || "").trim();
    if (!summary) {
      summary = extractedText.substring(0, MAX_SUMMARY_CHARS);
    }
  } catch (err) {
    // Fallback: return raw text if backend is unreachable
    return new Response(
      JSON.stringify({
        summary: extractedText.substring(0, MAX_SUMMARY_CHARS),
        raw: true,
        message: "AI summary unavailable. Raw text extracted instead.",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // 7. Store hash + summary in profiles
  await supabase
    .from("profiles")
    .update({
      resume_hash: resumeHash,
      resume_summary: summary,
      resume_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", user.id)
    .catch(() => {});

  return new Response(
    JSON.stringify({
      summary: summary,
      cached: false,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
};

export const config = {
  path: "/api/resume-upload",
};

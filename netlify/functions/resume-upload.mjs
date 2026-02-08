import { getAuthenticatedUser, getSupabaseAdmin } from "./shared/supabase.mjs";
import pdfParse from "pdf-parse";
import { getEnv } from "./shared/env.mjs";
import { jsonResponse, optionsResponse } from "./shared/http.mjs";

const SCANNED_THRESHOLD = 200;
const MAX_SUMMARY_CHARS = 900;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

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
    return optionsResponse();
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  // 1. Require authentication
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return jsonResponse(401, { error: "Not authenticated" });
  }

  // 2. Parse the multipart form data to get the PDF file
  let formData;
  try {
    formData = await req.formData();
  } catch (_) {
    return jsonResponse(400, { error: "Invalid form data" });
  }

  const file = formData.get("resume");
  if (!file || typeof file === "string") {
    return jsonResponse(400, { error: "No PDF file provided" });
  }

  const fileName = (file.name || "").toLowerCase();
  const isPdfType = (file.type || "").toLowerCase() === "application/pdf" || fileName.endsWith(".pdf");
  if (!isPdfType) {
    return jsonResponse(400, { error: "Only PDF files are supported." });
  }
  if (typeof file.size === "number" && file.size > MAX_FILE_BYTES) {
    return jsonResponse(413, { error: "File is too large. Max size is 20MB." });
  }

  // 3. Extract text from PDF
  let extractedText;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const parsed = await pdfParse(buffer);
    extractedText = (parsed.text || "").trim();
  } catch (err) {
    return jsonResponse(422, { error: "Failed to read PDF. Try a different file or paste your resume manually." });
  }

  // 4. Detect scanned/image PDFs
  if (extractedText.length < SCANNED_THRESHOLD) {
    return jsonResponse(422, {
      error: "scanned_pdf",
      message: "This looks like a scanned PDF. Upload a text-based PDF or paste your resume.",
    });
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
    return jsonResponse(200, {
      summary: profile.resume_summary,
      cached: true,
    });
  }

  // 6. Call AI to summarize the resume
  const backendUrl = getEnv("BACKEND_URL", "https://cover-letter-api-production-fe17.up.railway.app");

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
      return jsonResponse(200, {
        summary: extractedText.substring(0, MAX_SUMMARY_CHARS),
        raw: true,
        message: "AI summary unavailable. Raw text extracted instead.",
      });
    }

    summary = (aiData.text || "").trim();
    if (!summary) {
      summary = extractedText.substring(0, MAX_SUMMARY_CHARS);
    }
  } catch (err) {
    // Fallback: return raw text if backend is unreachable
    return jsonResponse(200, {
      summary: extractedText.substring(0, MAX_SUMMARY_CHARS),
      raw: true,
      message: "AI summary unavailable. Raw text extracted instead.",
    });
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

  return jsonResponse(200, {
    summary: summary,
    cached: false,
  });
};

export const config = {
  path: "/api/resume-upload",
};

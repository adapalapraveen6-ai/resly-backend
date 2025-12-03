import express from "express";
import cors from "cors";
import multer from "multer";
import sqlite3 from "sqlite3";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { fileURLToPath } from "url";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// ---------- FILE UPLOAD SETUP ----------
const upload = multer({ dest: path.join(__dirname, "uploads/") });

// ---------- DATABASE (SQLite) ----------
const dbPath = path.join(__dirname, "resly.db");
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      role TEXT,
      jd TEXT,
      resume_filename TEXT,
      used_ai INTEGER,
      output_length INTEGER
    )
  `);
});

// ---------- OPTIONAL OPENAI CLIENT ----------
let openai = null;
if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim() !== "") {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  console.log("✅ OpenAI enabled.");
} else {
  console.log("⚠ No OPENAI_API_KEY set. Using simple non-AI generator.");
}

// ---------- SIMPLE NON-AI GENERATOR (FALLBACK) ----------
function simpleGenerator(resumeText, jdText, role) {
  return `
TAILORED RESUME (SIMPLE MODE)

Target Role: ${role || "Not specified"}

-------------------------
ORIGINAL RESUME (SNIPPET)
-------------------------
${resumeText.slice(0, 1800)}

-------------------------
JOB DESCRIPTION (SNIPPET)
-------------------------
${jdText.slice(0, 1200)}

(Connect an OpenAI API key in the backend to get a professionally rewritten resume here.)
  `.trim();
}

// ---------- READ & PARSE UPLOADED FILE ----------
async function extractTextFromFile(file) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  const buffer = fs.readFileSync(file.path);

  try {
    if (ext === ".docx") {
      // Use mammoth for DOCX files
      const result = await mammoth.extractRawText({ buffer });
      return result.value || "";
    } else if (ext === ".pdf") {
      // Use pdf-parse for PDF files
      const data = await pdfParse(buffer);
      return data.text || "";
    } else if (ext === ".txt") {
      // Plain text
      return buffer.toString("utf8");
    } else {
      // Fallback: try UTF-8 text
      return buffer.toString("utf8");
    }
  } catch (err) {
    console.error("Error extracting text from file:", err);
    // Fallback: at least try raw text
    return buffer.toString("utf8");
  }
}

// ---------- API: HEALTH CHECK ----------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "Resly backend running" });
});

// ---------- API: GENERATE TAILORED RESUME ----------
app.post(
  "/api/generate",
  upload.single("resume"),
  async (req, res) => {
    const resumeFile = req.file;
    const jd = req.body.jd || "";
    const role = req.body.role || "";

    if (!resumeFile || !jd) {
      if (resumeFile) {
        fs.unlink(resumeFile.path, () => {});
      }
      return res.status(400).json({
        error: "Please upload a resume file and provide a job description (jd)."
      });
    }

    try {
      // 1) Extract clean text from uploaded resume
      const resumeText = await extractTextFromFile(resumeFile);

      let usedAI = 0;
      let tailoredText = "";

      // 2) If OpenAI key present, use AI; otherwise fallback
      if (openai) {
        try {
          const prompt = `
You are a world-class resume writer.

Rewrite the candidate's resume so it is strongly tailored to the job description.

RULES:
- Keep structure as a normal professional resume: SUMMARY, EXPERIENCE, SKILLS, EDUCATION, PROJECTS (if any).
- Rewrite bullet points using strong action verbs and quantified impact where possible.
- Match skills, tools, and keywords from the job description, but only if they are actually supported by the candidate's background.
- Do NOT invent fake companies or degrees.
- You may slightly reorder sections to highlight the most relevant experience.
- Keep the final length reasonable (about 1–2 pages in normal resume formatting).

CANDIDATE RESUME TEXT:
------------------------
${resumeText}

JOB DESCRIPTION:
------------------------
${jd}

TARGET ROLE TITLE: ${role || "Not specified"}
          `.trim();

          const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: "You are a professional resume writer." },
              { role: "user", content: prompt }
            ],
            temperature: 0.25
          });

          tailoredText = (completion.choices[0].message.content || "").trim();
          usedAI = 1;
        } catch (err) {
          console.error("OpenAI error, falling back to simple generator:", err);
          tailoredText = simpleGenerator(resumeText, jd, role);
          usedAI = 0;
        }
      } else {
        tailoredText = simpleGenerator(resumeText, jd, role);
      }

      // 3) Log to DB (non-blocking)
      db.run(
        `
        INSERT INTO generations (role, jd, resume_filename, used_ai, output_length)
        VALUES (?, ?, ?, ?, ?)
      `,
        [role, jd.slice(0, 2000), resumeFile.originalname, usedAI, tailoredText.length],
        (err) => {
          if (err) console.error("DB insert error:", err);
        }
      );

      // 4) Cleanup uploaded file
      fs.unlink(resumeFile.path, () => {});

      // 5) Send response
      return res.json({
        ok: true,
        usedAI: usedAI === 1,
        tailoredResume: tailoredText
      });
    } catch (error) {
      console.error("Unexpected error in /api/generate:", error);
      if (resumeFile) {
        fs.unlink(resumeFile.path, () => {});
      }
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`✅ Resly backend running on http://localhost:${PORT}`);
});

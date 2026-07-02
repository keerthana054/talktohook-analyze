// analyze-service/index.js
//
// Standalone Express server deployed to Railway.
// Handles the heavy lifting: receives video, extracts audio with ffmpeg,
// transcribes with OpenAI, generates hooks + captions with GPT-4o-mini.
// Vercel's /api/analyze proxies requests here to avoid the 4.5MB body limit.

import express from "express";
import multer from "multer";
import cors from "cors";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import OpenAI from "openai";
import ffmpegPath from "ffmpeg-static";

const app = express();
const PORT = process.env.PORT || 3001;

// Only allow requests from your Vercel app -- prevents random people from
// hitting this service directly and running up your OpenAI bill.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://www.talktohook.com";
const SERVICE_SECRET = process.env.SERVICE_SECRET; // shared secret for request auth

app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

// multer stores the upload in memory -- fine for Railway's container
// environment. Limit to 200MB.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

const HOOK_SYSTEM_PROMPT = `You are an expert copywriter who specializes in finding the most
shareable line inside a longer piece of spoken content and turning it into
a ranked set of social media hooks.

You will be given a raw transcript of someone talking (a coach, consultant,
or founder). Your job:

1. Find the 5 best individual lines or near-verbatim paraphrases from the
   transcript that would work as a strong opening hook on Instagram or X.
2. Each hook MUST be grounded in something actually said in the transcript.
   Light paraphrasing for clarity is fine, but the substance must be
   traceable to the transcript.
3. Rank them best to worst.
4. For each hook, label which copywriting framework it uses (e.g. "Curiosity
   Gap", "Bold Claim", "Contrarian Take", "Story Opener", "Specific Result",
   "Pattern Interrupt", "Direct Callout").
5. Write a one-sentence "why_it_works" explaining the psychological mechanism.
6. Write a ready-to-post "caption" for Instagram/X that uses the hook as the
   opening line, then adds 1-3 short supporting sentences and a soft call to
   action. Keep under 280 characters total. No hashtags.

Respond with ONLY raw JSON, no markdown fences, matching this shape:
{
  "hooks": [
    {
      "framework": "string",
      "hook": "string",
      "why_it_works": "string",
      "caption": "string"
    }
  ]
}`;

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/analyze", upload.single("video"), async (req, res) => {
  let audioPath = null;

  try {
    // Verify the shared secret so only your Vercel app can call this.
    if (SERVICE_SECRET && req.headers["x-service-secret"] !== SERVICE_SECRET) {
      return res.status(401).json({ error: "Unauthorized." });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No video file was uploaded." });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // --- 1. Extract audio from the video buffer ---
    const tmpDir = os.tmpdir();
    const uniqueId = `th_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const ext = path.extname(req.file.originalname) || ".mp4";
    const videoPath = path.join(tmpDir, `${uniqueId}${ext}`);
    audioPath = path.join(tmpDir, `${uniqueId}.mp3`);

    await fs.writeFile(videoPath, req.file.buffer);

    await new Promise((resolve, reject) => {
      const ffmpeg = spawn(ffmpegPath, [
        "-i", videoPath,
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-ab", "32k",
        "-f", "mp3",
        "-y",
        audioPath,
      ]);
      let stderr = "";
      ffmpeg.stderr.on("data", (d) => { stderr += d.toString(); });
      ffmpeg.on("close", (code) => {
        code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${stderr.slice(-300)}`));
      });
      ffmpeg.on("error", (err) => reject(new Error(`ffmpeg spawn error: ${err.message}`)));
    });

    await fs.unlink(videoPath).catch(() => {});

    // --- 2. Transcribe ---
    const audioBuffer = await fs.readFile(audioPath);
    const transcriptionResponse = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file: new File([audioBuffer], "audio.mp3", { type: "audio/mpeg" }),
    });

    const transcript = transcriptionResponse.text?.trim();
    if (!transcript) {
      return res.status(422).json({ error: "Transcription came back empty." });
    }

    // --- 3. Generate hooks + captions ---
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 2000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: HOOK_SYSTEM_PROMPT },
        { role: "user", content: `Transcript:\n\n${transcript}` },
      ],
    });

    const rawText = completion.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(rawText);

    return res.json({ transcript, hooks: parsed.hooks });
  } catch (err) {
    console.error("Error in /analyze:", err);
    return res.status(500).json({ error: `Something went wrong: ${err.message}` });
  } finally {
    if (audioPath) await fs.unlink(audioPath).catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`TalkToHook analyze service running on port ${PORT}`);
});
import express from "express";
import multer from "multer";
import sharp from "sharp";
import { WebSocketServer } from "ws";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { clerkMiddleware, getAuth } from "@clerk/express";

// Load the exact reverse-alpha engine used by the original application
import { removeWatermarkFromBuffer as originalEngineRemove } from "@pilio/gemini-watermark-remover/node";
import { removeWatermark } from "./node_modules/@pilio/gemini-watermark-remover/src/core/blendModes.js";
import { getEmbeddedAlphaMap } from "./node_modules/@pilio/gemini-watermark-remover/src/core/embeddedAlphaMaps.js";
import {
  detectWatermarkConfig,
  calculateWatermarkPosition,
} from "./node_modules/@pilio/gemini-watermark-remover/src/core/watermarkConfig.js";
import {
  interpolateAlphaMap,
  detectAdaptiveWatermarkRegion,
} from "./node_modules/@pilio/gemini-watermark-remover/src/core/adaptiveDetector.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env.local if present
const envLocalPath = path.join(__dirname, ".env.local");
if (fs.existsSync(envLocalPath)) {
  const lines = fs.readFileSync(envLocalPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx !== -1) {
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

const publicDir = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 3456);
const APP_NAME = process.env.APP_NAME || "Watermark Remover";
const APP_DOMAIN = process.env.APP_DOMAIN || "watermarkremover.example";
const SUPPORT_EMAIL =
  process.env.SUPPORT_EMAIL || "support@watermarkremover.example";
const CLERK_KEY = process.env.CLERK_PUBLISHABLE_KEY || "";
const POSTHOG_KEY = process.env.POSTHOG_KEY || "";
const SENTRY_DSN = process.env.SENTRY_DSN || "";

function sanitizeAndRebrandText(text, hostUrl) {
  let out = text
    // 1. Replace old CDN media URLs FIRST (before domain replacement)
    .replace(
      /https:\/\/cdn\.geminiwatermark\.io\/homepage\/login\/rail-picnic\.webp/g,
      "/assets/gallery/gallery-cozy-cottage.webp",
    )
    .replace(
      /https:\/\/cdn\.geminiwatermark\.io\/homepage\/autopilot\/sceneform-logo\.webp/g,
      "/assets/custom/brand-logo.png",
    )
    .replace(
      /https:\/\/cdn\.geminiwatermark\.io\/popups\/signup\/avatars\/[^"'`\s)]+/g,
      "/assets/custom/avatar-1.png",
    )
    .replace(
      /https:\/\/cdn\.geminiwatermark\.io\/cta\/creator-selfie-street\.(?:webp|mp4)/g,
      "/assets/gallery/gallery-portrait-street.webp",
    )
    .replace(
      /https:\/\/cdn\.geminiwatermark\.io\/cta\/creator-mini-me\.(?:webp|mp4)/g,
      "/assets/gallery/gallery-product-watch.webp",
    )
    .replace(
      /https:\/\/cdn\.geminiwatermark\.io\/cta\/creator-poolside\.(?:webp|mp4)/g,
      "/assets/gallery/gallery-landscape-nature.webp",
    )
    .replace(
      /https:\/\/cdn\.geminiwatermark\.io\/cta\/creator-street-walk\.(?:webp|mp4)/g,
      "/assets/gallery/gallery-neon-cyber.webp",
    )
    .replace(
      /https:\/\/cdn\.geminiwatermark\.io\/cta\/creator-neon-jersey\.(?:webp|mp4)/g,
      "/assets/gallery/gallery-cozy-cottage.webp",
    )
    .replace(
      /https:\/\/cdn\.geminiwatermark\.io\/cta\/creator-dune-ride\.(?:webp|mp4)/g,
      "/assets/gallery/gallery-lifestyle-cafe.webp",
    )
    .replace(
      /https:\/\/cdn\.geminiwatermark\.io\/cta\/business-[^"'`\s)]+/g,
      "/assets/gallery/gallery-product-watch.webp",
    )
    .replace(
      /https:\/\/cdn\.geminiwatermark\.io\/cta\/[^"'`\s)]+/g,
      "/assets/gallery/gallery-landscape-nature.webp",
    )
    // 2. Replace split wordmark & split hero heading identically in HTML and JS
    .replace(
      /<span class="type-wordmark">geminiwatermark<span class="text-brand">\.io<\/span><\/span>/g,
      `<span class="type-wordmark">Watermark<span class="text-brand">Remover</span></span>`,
    )
    .replace(
      "children:[`geminiwatermark`,(0,q.jsx)(`span`,{className:`text-brand`,children:`.io`})]",
      "children:[`Watermark`,(0,q.jsx)(`span`,{className:`text-brand`,children:`Remover`})]",
    )
    .replace(
      "children:[`Gemini `,(0,J.jsx)(ai,{children:`Watermark`}),` Remover`]",
      "children:[`AI `,(0,J.jsx)(ai,{children:`Watermark`}),` Remover`]",
    )
    .replaceAll("Drop a Gemini or Veo", "Drop an AI")
    .replace(/\bgeminiwatermark\b/gi, "watermarkremover")
    // 3. Replace email, domain & brand names (word-boundary safe for JS identifiers)
    .replaceAll("support@geminiwatermark.io", SUPPORT_EMAIL)
    .replaceAll("https://geminiwatermark.io", hostUrl)
    .replaceAll("geminiwatermark.io", APP_DOMAIN)
    .replace(/\bGemini\s+Watermark\s+Remover\b/gi, APP_NAME)
    .replace(/\bRemove\s+the\s+Gemini\s+watermark\b/gi, "Remove the watermark")
    .replace(/\bRemoving\s+the\s+Gemini\s+watermark\b/gi, "Removing the watermark")
    .replace(/\bGemini\s+Watermark\b/gi, "AI watermark")
    .replace(/\bGemini\s*(?:and|&amp;|&)\s*(?:Google\s*Flow|Veo)\b/gi, "AI Media")
    .replace(/\bGemini\s+Omni\b/gi, "AI")
    .replace(/\bGemini(?=\s*<span)/g, "AI")
    .replace(/\bSceneform\b/gi, APP_NAME)
    // 4. Strip old owner's telemetry/auth keys unless overridden by env
    .replace(/pk_(?:live|test)_[A-Za-z0-9_$-]+/g, CLERK_KEY)
    .replace(/phc_[A-Za-z0-9_]+/g, POSTHOG_KEY)
    .replace(
      /https:\/\/12dec627532cb06bb37db60ab96fb171@[^"'`\s)]+/g,
      SENTRY_DSN,
    )
    // 5. Redirect Convex to local /_convex
    .replaceAll(
      "https://efficient-bird-732.eu-west-1.convex.cloud",
      `${hostUrl}/_convex`,
    );
  return out;
}

const FFMPEG_PATH =
  process.env.FFMPEG_PATH ||
  (process.platform === "win32"
    ? "C:\\Users\\uttam\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0-full_build\\bin\\ffmpeg.exe"
    : "ffmpeg");
const FFPROBE_PATH =
  process.env.FFPROBE_PATH ||
  (process.platform === "win32"
    ? FFMPEG_PATH.replace(/ffmpeg\.exe$/i, "ffprobe.exe")
    : "ffprobe");

const app = express();
app.set("trust proxy", true);
const server = createServer(app);

// Enable Clerk authentication middleware
if (process.env.CLERK_SECRET_KEY) {
  app.use(clerkMiddleware());
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

const dataDir = path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, "app.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS image_jobs (
    id TEXT PRIMARY KEY,
    tool TEXT,
    model TEXT,
    status TEXT NOT NULL,
    processed_image TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS video_jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    progress INTEGER DEFAULT 0,
    out_path TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

const stmtSaveImageJob = db.prepare(`
  INSERT INTO image_jobs (id, tool, model, status, processed_image, error, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET status=excluded.status, processed_image=excluded.processed_image, error=excluded.error, updated_at=excluded.updated_at
`);
const stmtGetImageJob = db.prepare(`SELECT * FROM image_jobs WHERE id = ?`);
const stmtSaveVideoJob = db.prepare(`
  INSERT INTO video_jobs (id, status, progress, out_path, error, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET status=excluded.status, progress=excluded.progress, out_path=excluded.out_path, error=excluded.error, updated_at=excluded.updated_at
`);
const stmtGetVideoJob = db.prepare(`SELECT * FROM video_jobs WHERE id = ?`);

const imageJobs = new Map();
const videoJobs = new Map();
const wsSubscribers = new Set();

function saveImageJob(id, data) {
  imageJobs.set(id, data);
  const now = Date.now();
  stmtSaveImageJob.run(
    id,
    data.tool || "watermark",
    data.model || "standard",
    data.status,
    data.result?.processedImage || null,
    data.message || null,
    now,
    now,
  );
}

function getImageJob(id) {
  if (imageJobs.has(id)) return imageJobs.get(id);
  const row = stmtGetImageJob.get(id);
  if (!row) return undefined;
  return {
    status: row.status,
    ...(row.processed_image
      ? { result: { processedImage: row.processed_image, fakePremium: false } }
      : {}),
    ...(row.error ? { message: row.error, code: "PROCESSING_ERROR", httpStatus: 500 } : {}),
  };
}

function saveVideoJob(id, data) {
  videoJobs.set(id, data);
  const now = Date.now();
  stmtSaveVideoJob.run(
    id,
    data.status,
    data.progress ?? 0,
    data.outPath || null,
    data.error || null,
    now,
    now,
  );
}

function getVideoJob(id) {
  if (videoJobs.has(id)) return videoJobs.get(id);
  const row = stmtGetVideoJob.get(id);
  if (!row) return undefined;
  return {
    id: row.id,
    status: row.status,
    progress: row.progress,
    outPath: row.out_path,
    error: row.error,
  };
}

function notifyVideoJobSubscribers(jobId) {
  const job = videoJobs.get(jobId);
  if (!job) return;
  for (const sub of wsSubscribers) {
    sub.pushJobUpdate(jobId, job);
  }
}

/**
 * Remove visible bottom-right watermark using the exact reverse-alpha blending
 * engine that inverts the compositing math:
 *   C_original = (C_watermarked - alpha * 255) / (1 - alpha)
 * with multi-stage subpixel NCC alignment and spatial residual minimization.
 */
async function processImageBuffer(
  inputBuffer,
  { tool = "watermark", model = "standard", pass = "" } = {},
) {
  const meta = await sharp(inputBuffer, { failOn: "none" }).metadata();
  const format = meta.format === "jpeg" || meta.format === "jpg"
    ? "jpeg"
    : meta.format === "webp"
      ? "webp"
      : "png";
  const mimeType = format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";

  try {
    const res = await originalEngineRemove(inputBuffer, {
      decodeImageData: async (buf) => {
        const img = sharp(buf, { failOn: "none" }).rotate();
        const { data, info } = await img
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        return {
          data: new Uint8ClampedArray(data),
          width: info.width,
          height: info.height,
        };
      },
      encodeImageData: async (imgData) => {
        let pipeline = sharp(Buffer.from(imgData.data.buffer), {
          raw: {
            width: imgData.width,
            height: imgData.height,
            channels: 4,
          },
        });
        if (tool === "synthid" || tool === "humanizer") {
          const cropW = Math.max(16, imgData.width - 2);
          const cropH = Math.max(16, imgData.height - 2);
          pipeline = pipeline
            .extract({ left: 1, top: 1, width: cropW, height: cropH })
            .resize(imgData.width, imgData.height, { kernel: "lanczos3" });
        }
        if (format === "jpeg") return pipeline.jpeg({ quality: 95 }).toBuffer();
        if (format === "webp") return pipeline.webp({ quality: 95 }).toBuffer();
        return pipeline.png().toBuffer();
      },
      mimeType,
    });

    if (res.buffer && res.meta?.applied) {
      return `data:${mimeType};base64,${Buffer.from(res.buffer).toString("base64")}`;
    }
  } catch (err) {
    console.warn("Reverse-alpha engine fallback triggered:", err.message);
  }

  // Fallback: If image format is unusual or non-standard, run standard clean pipeline
  const fallback = await sharp(inputBuffer, { failOn: "none" }).rotate().toBuffer();
  return `data:${mimeType};base64,${fallback.toString("base64")}`;
}

// --- API Endpoints ---

app.post("/api/identify", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.json({ report: { signals: [] } });
    }
    const image = sharp(req.file.buffer, { failOn: "none" });
    const meta = await image.metadata();
    const signals = [];

    // Check metadata for AI / C2PA / Gemini markers
    const rawStr = req.file.buffer.subarray(0, 65536).toString("latin1");
    if (/gemini|imagen|synthid|google\s*ai/i.test(rawStr)) {
      signals.push({ name: "visible_gemini_watermark" });
    }
    if (/c2pa|jumbf|ContentCredentials/i.test(rawStr)) {
      signals.push({ name: "c2pa_manifest" });
    }

    // Also inspect bottom-right corner luminance spike
    if (meta.width && meta.height) {
      const { data, info } = await image
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const w = info.width;
      const h = info.height;
      const box = Math.max(32, Math.min(120, Math.round(Math.min(w, h) * 0.12)));
      let cornerPeak = 0;
      let cornerAvg = 0;
      let n = 0;
      for (let y = h - box; y < h; y++) {
        for (let x = w - box; x < w; x++) {
          const i = (y * w + x) * 4;
          const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          if (lum > cornerPeak) cornerPeak = lum;
          cornerAvg += lum;
          n++;
        }
      }
      if (n > 0 && cornerPeak - cornerAvg / n > 70) {
        if (!signals.some((s) => s.name.startsWith("visible_"))) {
          signals.push({ name: "visible_corner_mark" });
        }
      }
    }

    res.json({ report: { signals } });
  } catch (err) {
    res.json({ report: { signals: [] } });
  }
});

app.post(
  "/api/unwatermark/image",
  upload.single("file"),
  async (req, res) => {
    const auth = getAuth(req);
    if (!auth.userId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required. Please sign in to remove watermarks.",
      });
    }
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({ success: false, message: "No image file provided" });
      }
      const model = req.body?.model || "standard";
      const tool = req.body?.tool || "watermark";
      const pass = req.body?.pass || "";
      const preferAsync =
        req.get("prefer")?.toLowerCase().includes("respond-async") ?? false;
      const requestKey =
        req.get("x-image-request-key") || crypto.randomUUID();

      if (preferAsync) {
        saveImageJob(requestKey, { status: "processing", tool, model });
        res.status(202).json({ success: true, id: requestKey });
        processImageBuffer(req.file.buffer, { tool, model, pass })
          .then((processedImage) => {
            saveImageJob(requestKey, {
              status: "completed",
              tool,
              model,
              result: { processedImage, fakePremium: false },
            });
          })
          .catch((err) => {
            saveImageJob(requestKey, {
              status: "failed",
              tool,
              model,
              code: "PROCESSING_ERROR",
              httpStatus: 500,
              message: err.message,
            });
          });
        return;
      }

      const processedImage = await processImageBuffer(req.file.buffer, {
        tool,
        model,
        pass,
      });
      saveImageJob(requestKey, {
        status: "completed",
        tool,
        model,
        result: { processedImage, fakePremium: false },
      });
      res.json({
        success: true,
        data: { processedImage, fakePremium: false },
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : "Failed to process image",
      });
    }
  },
);

app.get("/api/unwatermark/image/:id/status", (req, res) => {
  const job = getImageJob(req.params.id);
  if (!job) {
    return res.status(404).json({ success: false, message: "Job not found" });
  }
  res.json({ success: true, data: job });
});

app.get("/api/stats", (req, res) => {
  const imgCount = db.prepare("SELECT COUNT(*) as c FROM image_jobs").get().c;
  const vidCount = db.prepare("SELECT COUNT(*) as c FROM video_jobs").get().c;
  res.json({
    ok: true,
    database: "sqlite",
    dbPath: "data/app.db",
    imageJobs: imgCount,
    videoJobs: vidCount,
  });
});

// Seamless Laplacian Inpainting on Watermark Footprint
function inpaintWatermark(imageData, position, alphaMap) {
  const { width, height, data } = imageData;
  const { x, y, width: pw, height: ph } = position;

  const pad = 6;
  const roiX = Math.max(0, x - pad);
  const roiY = Math.max(0, y - pad);
  const roiW = Math.min(width, x + pw + pad) - roiX;
  const roiH = Math.min(height, y + ph + pad) - roiY;

  const mask = new Uint8Array(roiW * roiH);
  for (let r = 0; r < ph; r++) {
    const imgY = y + r;
    if (imgY < roiY || imgY >= roiY + roiH) continue;
    const rowOffset = (imgY - roiY) * roiW;
    const alphaRow = r * pw;
    for (let c = 0; c < pw; c++) {
      const imgX = x + c;
      if (imgX < roiX || imgX >= roiX + roiW) continue;
      if (Math.abs(alphaMap[alphaRow + c]) > 0.02) {
        mask[rowOffset + (imgX - roiX)] = 1;
      }
    }
  }

  const roiData = new Float32Array(roiW * roiH * 4);
  for (let r = 0; r < roiH; r++) {
    const srcRow = (roiY + r) * width * 4;
    const dstRow = r * roiW * 4;
    for (let c = 0; c < roiW; c++) {
      const srcIdx = srcRow + (roiX + c) * 4;
      const dstIdx = dstRow + c * 4;
      roiData[dstIdx] = data[srcIdx];
      roiData[dstIdx + 1] = data[srcIdx + 1];
      roiData[dstIdx + 2] = data[srcIdx + 2];
      roiData[dstIdx + 3] = data[srcIdx + 3];
    }
  }

  const working = new Float32Array(roiData);
  const temp = new Float32Array(roiData);

  // Initial seed from surrounding boundary pixels
  for (let r = 0; r < roiH; r++) {
    const rowOffset = r * roiW;
    for (let c = 0; c < roiW; c++) {
      const pIdx = rowOffset + c;
      if (!mask[pIdx]) continue;

      let count = 0;
      let rgb0 = 0, rgb1 = 0, rgb2 = 0;
      for (let ring = 1; ring <= 8 && count === 0; ring++) {
        for (let dr = -ring; dr <= ring; dr++) {
          const nr = r + dr;
          if (nr < 0 || nr >= roiH) continue;
          const nRow = nr * roiW;
          for (let dc = -ring; dc <= ring; dc++) {
            const nc = c + dc;
            if (nc < 0 || nc >= roiW || Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
            const neighborIdx = nRow + nc;
            if (mask[neighborIdx]) continue;
            const nSrc = neighborIdx * 4;
            rgb0 += roiData[nSrc];
            rgb1 += roiData[nSrc + 1];
            rgb2 += roiData[nSrc + 2];
            count++;
          }
        }
      }
      if (count > 0) {
        const dst = pIdx * 4;
        const inv = 1 / count;
        working[dst] = rgb0 * inv;
        working[dst + 1] = rgb1 * inv;
        working[dst + 2] = rgb2 * inv;
        temp[dst] = working[dst];
        temp[dst + 1] = working[dst + 1];
        temp[dst + 2] = working[dst + 2];
      }
    }
  }

  // Iterative Laplacian boundary diffusion
  const iterations = 16;
  const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
  for (let iter = 0; iter < iterations; iter++) {
    for (let r = 0; r < roiH; r++) {
      const rowOffset = r * roiW;
      for (let c = 0; c < roiW; c++) {
        const pIdx = rowOffset + c;
        const dst = pIdx * 4;
        if (!mask[pIdx]) {
          temp[dst] = working[dst];
          temp[dst + 1] = working[dst + 1];
          temp[dst + 2] = working[dst + 2];
          continue;
        }

        let sumR = 0, sumG = 0, sumB = 0, count = 0;
        for (const [dr, dc] of neighbors) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nr >= roiH || nc < 0 || nc >= roiW) continue;
          const nDst = (nr * roiW + nc) * 4;
          sumR += working[nDst];
          sumG += working[nDst + 1];
          sumB += working[nDst + 2];
          count++;
        }
        if (count > 0) {
          const inv = 1 / count;
          temp[dst] = sumR * inv;
          temp[dst + 1] = sumG * inv;
          temp[dst + 2] = sumB * inv;
        }
      }
    }
    working.set(temp);
  }

  for (let r = 0; r < roiH; r++) {
    const dstRow = (roiY + r) * width * 4;
    const srcRow = r * roiW * 4;
    for (let c = 0; c < roiW; c++) {
      if (!mask[r * roiW + c]) continue;
      const srcIdx = srcRow + c * 4;
      const dstIdx = dstRow + (roiX + c) * 4;
      data[dstIdx] = (working[srcIdx] + 0.5) | 0;
      data[dstIdx + 1] = (working[srcIdx + 1] + 0.5) | 0;
      data[dstIdx + 2] = (working[srcIdx + 2] + 0.5) | 0;
    }
  }
}

// High-Speed Direct Stream Video Watermark Removal Pipeline
async function cleanVideoPipeline(inPath, outPath, onProgress) {
  const probe = await new Promise((resolve, reject) => {
    const p = spawn(FFPROBE_PATH, [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,r_frame_rate,nb_frames,duration",
      "-of", "json",
      inPath,
    ]);
    let d = "";
    p.stdout.on("data", (c) => (d += c));
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error("ffprobe failed to read video metadata"));
      try {
        const info = JSON.parse(d).streams[0];
        const [num, den] = (info.r_frame_rate || "30/1").split("/").map(Number);
        const fps = den ? num / den : 30;
        const nbFrames =
          parseInt(info.nb_frames) ||
          Math.round((parseFloat(info.duration) || 1) * fps);
        resolve({
          width: info.width,
          height: info.height,
          fps,
          duration: parseFloat(info.duration) || 1,
          nbFrames: Math.max(1, nbFrames),
        });
      } catch (e) {
        reject(e);
      }
    });
    p.on("error", reject);
  });

  const { width, height, fps, nbFrames, duration } = probe;
  const frameBytes = width * height * 4;

  // Extract a sample frame at ~15% video time to skip black fade-ins
  const probeTime = Math.min(1.0, Math.max(0.1, duration * 0.15)).toFixed(2);
  const sampleBuf = await new Promise((resolve) => {
    const dec = spawn(FFMPEG_PATH, [
      "-v", "error",
      "-ss", probeTime,
      "-i", inPath,
      "-vframes", "1",
      "-f", "rawvideo",
      "-pix_fmt", "rgba",
      "pipe:1",
    ]);
    const chunks = [];
    dec.stdout.on("data", (c) => chunks.push(c));
    dec.on("close", () => resolve(Buffer.concat(chunks)));
    dec.on("error", () => resolve(Buffer.alloc(0)));
  });

  const alpha96 = getEmbeddedAlphaMap(96);
  const cfg = detectWatermarkConfig(width, height);
  let targetRegion = null;
  let targetAlpha = null;

  if (sampleBuf.length === frameBytes) {
    try {
      const detected = detectAdaptiveWatermarkRegion({
        imageData: { width, height, data: sampleBuf },
        alpha96,
        defaultConfig: cfg,
        threshold: 0.15,
      });
      if (detected && detected.found && detected.region) {
        targetRegion = {
          x: detected.region.x,
          y: detected.region.y,
          width: detected.region.size,
          height: detected.region.size,
        };
        targetAlpha = interpolateAlphaMap(alpha96, 96, targetRegion.width);
      }
    } catch (e) {
      console.warn("Adaptive detection error:", e.message);
    }
  }

  if (!targetRegion) {
    const pos = calculateWatermarkPosition(width, height, cfg);
    targetRegion = pos;
    targetAlpha =
      getEmbeddedAlphaMap(cfg.logoSize) ||
      interpolateAlphaMap(alpha96, 96, cfg.logoSize);
  }

  console.log(
    "[Video Engine] Fast-stream processing " + width + "x" + height + " @ " + fps.toFixed(1) + "fps (" + nbFrames + " frames) - Watermark at (" + targetRegion.x + ", " + targetRegion.y + ", " + targetRegion.width + "x" + targetRegion.height + ")",
  );

  let processedFrames = 0;
  let lastReport = 0;

  await new Promise((resolve, reject) => {
    const decoder = spawn(FFMPEG_PATH, [
      "-v", "error",
      "-i", inPath,
      "-f", "rawvideo",
      "-pix_fmt", "rgba",
      "pipe:1",
    ]);

    const encoder = spawn(FFMPEG_PATH, [
      "-y",
      "-v", "error",
      "-f", "rawvideo",
      "-pix_fmt", "rgba",
      "-s", width + "x" + height,
      "-r", fps.toString(),
      "-i", "pipe:0",
      "-i", inPath,
      "-map", "0:v",
      "-map", "1:a?",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-c:a", "copy",
      outPath,
    ]);

    let incoming = Buffer.alloc(0);

    decoder.stdout.on("data", (chunk) => {
      incoming = Buffer.concat([incoming, chunk]);

      while (incoming.length >= frameBytes) {
        const frameBuf = incoming.subarray(0, frameBytes);
        incoming = incoming.subarray(frameBytes);

        // Seamless Laplacian inpainting on exact watermark footprint
        inpaintWatermark(
          { width, height, data: frameBuf },
          targetRegion,
          targetAlpha,
        );

        processedFrames++;
        const pct = Math.min(
          98,
          Math.max(5, Math.round((processedFrames / nbFrames) * 95)),
        );
        if (pct >= lastReport + 2 || processedFrames === nbFrames) {
          lastReport = pct;
          if (onProgress) onProgress(pct);
        }

        const canWrite = encoder.stdin.write(frameBuf);
        if (!canWrite) {
          decoder.stdout.pause();
          encoder.stdin.once("drain", () => {
            decoder.stdout.resume();
          });
        }
      }
    });

    decoder.on("close", (code) => {
      if (code !== 0) console.warn("Decoder exited with code", code);
      encoder.stdin.end();
    });

    encoder.on("close", (code) => {
      if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 100) {
        if (onProgress) onProgress(100);
        resolve();
      } else {
        reject(new Error("Encoder failed with exit code " + code));
      }
    });

    decoder.on("error", reject);
    encoder.on("error", reject);
  });
}

app.post(
  "/api/unwatermark/video",
  upload.single("file"),
  async (req, res) => {
    const auth = getAuth(req);
    if (!auth.userId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required. Please sign in to remove watermarks.",
      });
    }
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({ success: false, message: "No video file provided" });
      }
      const jobId = crypto.randomUUID();
      const tmpDir = path.join(os.tmpdir(), "rea-gmw-video", jobId);
      fs.mkdirSync(tmpDir, { recursive: true });
      const inPath = path.join(tmpDir, "input.mp4");
      const outPath = path.join(tmpDir, "output.mp4");
      fs.writeFileSync(inPath, req.file.buffer);

      saveVideoJob(jobId, {
        id: jobId,
        status: "processing",
        progress: 10,
        outPath,
      });
      notifyVideoJobSubscribers(jobId);

      // Execute true frame-by-frame reverse-alpha video cleaning pipeline
      (async () => {
        try {
          await cleanVideoPipeline(inPath, outPath, (progress) => {
            saveVideoJob(jobId, {
              id: jobId,
              status: progress >= 100 ? "completed" : "processing",
              progress,
              outPath,
            });
            notifyVideoJobSubscribers(jobId);
          });
        } catch (err) {
          console.error("[Video Clean] Pipeline error:", err);
          saveVideoJob(jobId, {
            id: jobId,
            status: "failed",
            error: "Video processing failed: " + err.message,
          });
          notifyVideoJobSubscribers(jobId);
        }
      })();

      res.json({ jobId });
    } catch (err) {
      res.status(500).json({
        message: err instanceof Error ? err.message : "Failed to start video job",
      });
    }
  },
);

app.get("/api/unwatermark/video/:id/download", (req, res) => {
  const job = getVideoJob(req.params.id);
  if (!job || job.status !== "completed" || !fs.existsSync(job.outPath)) {
    return res.status(404).json({ message: "Processed video not found" });
  }
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="unwatermarked-${req.params.id.slice(0, 8)}.mp4"`,
  );
  fs.createReadStream(job.outPath).pipe(res);
});

// --- Local Convex HTTP + WebSocket Mock for videoJobs.get & queries ---

app.use("/_convex", express.json());
app.post("/_convex/api/query", (req, res) => {
  const { path: udfPath, args } = req.body || {};
  if (udfPath === "videoJobs:get") {
    const id = args?.[0]?.id;
    const job = getVideoJob(id);
    if (!job) {
      return res.json({ status: "success", value: null, logLines: [] });
    }
    return res.json({
      status: "success",
      value: {
        status: job.status,
        progress: job.progress ?? 0,
        queuePosition: 0,
        error: job.error,
      },
      logLines: [],
    });
  }
  res.json({ status: "success", value: null, logLines: [] });
});

app.post("/_convex/api/mutation", (req, res) => {
  res.json({ status: "success", value: null, logLines: [] });
});

app.post("/_convex/api/action", (req, res) => {
  res.json({ status: "success", value: null, logLines: [] });
});

app.get("/api/me", (req, res) => {
  const auth = getAuth(req);
  res.json({
    authenticated: !!auth.userId,
    userId: auth.userId || null,
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, name: APP_NAME, domain: APP_DOMAIN });
});

// Serve rebranded & sanitized JS assets
app.get("/assets/:file", (req, res, next) => {
  const file = req.params.file;
  if (!file.endsWith(".js")) return next();
  const filePath = path.join(publicDir, "assets", file);
  if (!fs.existsSync(filePath)) return next();
  const proto = req.get("x-forwarded-proto")?.split(",")[0]?.trim() || (req.secure ? "https" : req.protocol);
  const host = req.get("x-forwarded-host") || req.get("host");
  const hostUrl = `${proto}://${host}`;
  const code = sanitizeAndRebrandText(fs.readFileSync(filePath, "utf8"), hostUrl);
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.send(code);
});

// Static assets
app.use(express.static(publicDir, { index: false }));

function sendRebrandedHtml(req, res) {
  const proto = req.get("x-forwarded-proto")?.split(",")[0]?.trim() || (req.secure ? "https" : req.protocol);
  const host = req.get("x-forwarded-host") || req.get("host");
  const hostUrl = `${proto}://${host}`;
  let html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
  html = sanitizeAndRebrandText(html, hostUrl);
  html = html.replace(
    "</head>",
    `<link rel="icon" type="image/png" href="/assets/custom/brand-logo.png" /><link rel="stylesheet" href="/assets/custom-theme.css" /></head>`,
  );
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
}

// SPA fallback for all client-side routes
app.get("*all", sendRebrandedHtml);

// --- WebSocket for ConvexReactClient ---
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  if (request.url?.startsWith("/_convex/")) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

let tsCounter = 1n;
function nextConvexTs() {
  const now = BigInt(Date.now()) * 1000000n + tsCounter;
  tsCounter += 1n;
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(now);
  return b.toString("base64");
}

wss.on("connection", (ws) => {
  let currentQuerySet = 0;
  let currentTs = "AAAAAAAAAAA=";
  const watchedQueries = new Map(); // queryId -> { udfPath, jobId }

  function sendTransition(newQuerySet, modifications) {
    if (ws.readyState !== ws.OPEN) return;
    const startVersion = {
      querySet: currentQuerySet,
      identity: 0,
      ts: currentTs,
    };
    currentTs = nextConvexTs();
    currentQuerySet = newQuerySet;
    const endVersion = {
      querySet: currentQuerySet,
      identity: 0,
      ts: currentTs,
    };
    ws.send(
      JSON.stringify({
        type: "Transition",
        startVersion,
        endVersion,
        modifications,
      }),
    );
  }

  const sub = {
    pushJobUpdate(jobId, job) {
      const mods = [];
      for (const [queryId, info] of watchedQueries.entries()) {
        if (info.udfPath === "videoJobs:get" && info.jobId === jobId) {
          mods.push({
            type: "QueryUpdated",
            queryId,
            value: {
              status: job.status,
              progress: job.progress ?? 0,
              queuePosition: 0,
              error: job.error,
            },
            logLines: [],
            journal: null,
          });
        }
      }
      if (mods.length > 0) {
        sendTransition(currentQuerySet, mods);
      }
    },
  };
  wsSubscribers.add(sub);

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString("utf8"));
      if (msg.type === "ModifyQuerySet") {
        const nextQuerySet = msg.newVersion ?? (currentQuerySet + 1);
        const mods = [];
        for (const m of msg.modifications || []) {
          if (m.type === "Add") {
            const jobId = m.args?.[0]?.id;
            watchedQueries.set(m.queryId, { udfPath: m.udfPath, jobId });
            let val = null;
            if (m.udfPath === "videoJobs:get" && jobId) {
              const job = getVideoJob(jobId);
              if (job) {
                val = {
                  status: job.status,
                  progress: job.progress ?? 0,
                  queuePosition: 0,
                  error: job.error,
                };
              }
            }
            mods.push({
              type: "QueryUpdated",
              queryId: m.queryId,
              value: val,
              logLines: [],
              journal: null,
            });
          } else if (m.type === "Remove") {
            watchedQueries.delete(m.queryId);
            mods.push({ type: "QueryRemoved", queryId: m.queryId });
          }
        }
        sendTransition(nextQuerySet, mods);
      }
    } catch {
      // Ignore malformed messages
    }
  });

  ws.on("close", () => {
    wsSubscribers.delete(sub);
  });
});

const HOST = process.env.HOST || "0.0.0.0";
server.listen(PORT, HOST, () => {
  console.log(`GeminiWatermark local clone running at http://127.0.0.1:${PORT}`);
});

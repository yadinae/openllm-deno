/**
 * Transcription inbound — /v1/audio/transcriptions
 * Multipart upload → STT providers.
 */
import { Hono } from "hono";
import { runTranscription } from "../services/transcription.ts";
import { requestLogger, generateRequestId } from "../services/request-log.ts";

const transcriptionRouter = new Hono();

async function parseMultipart(c: any): Promise<{ file: Uint8Array; filename: string; mimeType: string; fields: Record<string, string> } | { error: Response }> {
  const contentType = c.req.header("content-type");
  if (!contentType || !contentType.startsWith("multipart/form-data")) {
    return { error: c.json({ error: { type: "invalid_request_error", message: "Content-Type must be multipart/form-data" } }, 400) };
  }

  const boundary = contentType.split("boundary=")[1];
  if (!boundary) {
    return { error: c.json({ error: { type: "invalid_request_error", message: "Missing boundary in multipart/form-data" } }, 400) };
  }

  const body = await c.req.arrayBuffer();
  const parts = parseMultipartBody(body, boundary);

  const filePart = parts.find(p => p.name === "file" && p.filename);
  if (!filePart || !filePart.data.byteLength) {
    return { error: c.json({ error: { type: "invalid_request_error", message: "file is required (multipart/form-data audio upload)" } }, 400) };
  }

  const fields: Record<string, string> = {};
  for (const p of parts) {
    if (p.name && p.name !== "file") fields[p.name] = p.value;
  }

  return {
    file: new Uint8Array(filePart.data),
    filename: filePart.filename || "audio",
    mimeType: filePart.contentType || "audio/mpeg",
    fields,
  };
}

function parseMultipartBody(buffer: ArrayBuffer, boundary: string): Array<{ name: string; filename?: string; contentType?: string; value: string; data: ArrayBuffer }> {
  const decoder = new TextDecoder();
  const full = decoder.decode(buffer);
  const parts = full.split(`--${boundary}`);
  const result = [];

  for (const part of parts) {
    if (!part.trim() || part.includes("--")) continue;
    const [headers, ...bodyParts] = part.split("\r\n\r\n");
    if (!bodyParts.length) continue;
    const body = bodyParts.join("\r\n\r\n").replace(/\r\n$/, "");

    const headerLines = headers.split("\r\n");
    let name = "";
    let filename = "";
    let contentType = "";

    for (const line of headerLines) {
      if (line.startsWith("Content-Disposition:")) {
        const nameMatch = line.match(/name="([^"]+)"/);
        if (nameMatch) name = nameMatch[1];
        const fileMatch = line.match(/filename="([^"]+)"/);
        if (fileMatch) filename = fileMatch[1];
      } else if (line.startsWith("Content-Type:")) {
        contentType = line.split(":")[1].trim();
      }
    }

    result.push({ name, filename, contentType, value: body, data: new TextEncoder().encode(body).buffer });
  }

  return result;
}

transcriptionRouter.post("/audio/transcriptions", async (c) => {
  const vRequestId = generateRequestId();
  const vStart = Date.now();

  const parsed = await parseMultipart(c);
  if ("error" in parsed) return parsed.error;

  const { file, filename, mimeType, fields } = parsed;

  if (file.byteLength > 25 * 1024 * 1024) {
    return c.json({ error: { type: "invalid_request_error", message: "Audio file too large: maximum 25 MB" } }, 413);
  }

  const model = fields.model?.trim();
  if (!model) {
    return c.json({ error: { type: "invalid_request_error", message: "model is required (use 'whisper-1' or 'auto')" } }, 400);
  }

  const rawFormat = fields.response_format?.trim() || "json";
  if (!["json", "text", "verbose_json", "vtt"].includes(rawFormat)) {
    return c.json({ error: { type: "invalid_request_error", message: `Invalid response_format '${rawFormat}'. Supported: json, text, verbose_json, vtt.` } }, 400);
  }
  if (rawFormat === "srt") {
    return c.json({ error: { type: "invalid_request_error", message: "response_format 'srt' is not supported: no provider produces srt natively." } }, 400);
  }

  let temperature: number | undefined;
  if (fields.temperature !== undefined && fields.temperature !== "") {
    temperature = Number(fields.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) {
      return c.json({ error: { type: "invalid_request_error", message: "Invalid temperature: must be 0-1" } }, 400);
    }
  }

  const language = fields.language?.trim() || undefined;
  const prompt = fields.prompt?.trim() || undefined;

  try {
    const result = await runTranscription(model, {
      file,
      filename,
      mimeType,
      model,
      language,
      prompt,
      response_format: rawFormat as "json" | "text" | "verbose_json" | "vtt",
      temperature,
    });

    if (rawFormat === "text") {
      return c.text(result.text);
    } else if (rawFormat === "verbose_json") {
      return c.json(result);
    } else if (rawFormat === "vtt") {
      if (result.segments) {
        let vtt = "WEBVTT\n\n";
        for (const seg of result.segments) {
          const start = formatTime(seg.start);
          const end = formatTime(seg.end);
          vtt += `${start} --> ${end}\n${seg.text}\n\n`;
        }
        return c.text(vtt);
      }
      return c.text(result.text);
    } else {
      return c.json({ text: result.text });
    }
  } catch (e: any) {
    const msg = e instanceof Error ? e.message : String(e);
    await requestLogger.logComplete(vRequestId, "transcription", "transcription", 0, undefined, { model } as any, null, Date.now() - vStart, 503, msg);
    return c.json({ error: { type: "server_error", message: msg } }, 503);
  }
});

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
}

export default transcriptionRouter;
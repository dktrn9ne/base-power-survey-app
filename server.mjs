import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";
const MAX_BODY_BYTES = 36 * 1024 * 1024;
const MAX_IMAGES = 6;
const MAX_IMAGE_DATA_LENGTH = 5_500_000;
const surveyHtml = await readFile(new URL("./index.html", import.meta.url));

const qualificationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    outcome: { type: "string", enum: ["qualified", "manual_review", "insufficient_evidence"] },
    confidence: { type: "integer", minimum: 0, maximum: 100 },
    summary: { type: "string" },
    rules: {
      type: "array",
      minItems: 6,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string", enum: ["pass", "review", "unknown"] },
          label: { type: "string" },
        },
        required: ["status", "label"],
      },
    },
    requests: { type: "array", items: { type: "string" }, maxItems: 8 },
  },
  required: ["outcome", "confidence", "summary", "rules", "requests"],
};

const instructions = `You are assisting a residential battery-install survey reviewer.
Assess only the evidence supplied in the request. Never infer that a required clearance, label,
equipment rating, conductor condition, or access path is acceptable when it is not directly shown
or explicitly confirmed. Treat unchecked constraints as unknown, not failed. A visible hazard,
obstruction, ambiguous service equipment, or missing critical photo requires manual review or more
evidence. This is a preliminary remote screening, never final engineering or utility approval.

Return exactly six concise rules covering: meter evidence, main panel relationship, service
disconnect space, battery placement area, clearances and conduit path, and unresolved obstructions.
Use qualified only when every critical item is directly supported and no conflict is visible.
Use insufficient_evidence when critical evidence is missing. Otherwise use manual_review.`;

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function extractOutputText(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.output_text === "string") return payload.output_text;
  if (!Array.isArray(payload.output)) return null;
  for (const item of payload.output) {
    if (!Array.isArray(item?.content)) continue;
    for (const part of item.content) {
      if (typeof part?.text === "string") return part.text;
    }
  }
  return null;
}

async function qualifySurvey(request, response) {
  if (!process.env.OPENAI_API_KEY) {
    sendJson(response, 503, { error: "AI qualification is not configured." });
    return;
  }

  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    const status = error?.message === "REQUEST_TOO_LARGE" ? 413 : 400;
    sendJson(response, status, { error: status === 413 ? "The photo upload is too large." : "The survey request was not valid JSON." });
    return;
  }

  const survey = body?.survey && typeof body.survey === "object" ? body.survey : {};
  const images = Array.isArray(body?.images) ? body.images.slice(0, MAX_IMAGES) : [];
  const validImages = images.filter(
    (image) =>
      typeof image?.dataUrl === "string" &&
      /^data:image\/(jpeg|png|webp|gif);base64,/i.test(image.dataUrl) &&
      image.dataUrl.length <= MAX_IMAGE_DATA_LENGTH,
  );

  const content = [
    {
      type: "input_text",
      text: `Survey record:\n${JSON.stringify(survey).slice(0, 60_000)}\n\nAttached evidence images: ${validImages.length}.`,
    },
  ];

  for (const image of validImages) {
    content.push({
      type: "input_text",
      text: `Evidence category: ${String(image.category || "uncategorized")}; file: ${String(image.name || "photo")}`,
    });
    content.push({ type: "input_image", image_url: image.dataUrl, detail: "high" });
  }

  let openAIResponse;
  try {
    openAIResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        instructions,
        input: [{ role: "user", content }],
        reasoning: { effort: "low" },
        text: {
          verbosity: "low",
          format: {
            type: "json_schema",
            name: "survey_qualification",
            strict: true,
            schema: qualificationSchema,
          },
        },
        store: false,
      }),
    });
  } catch {
    sendJson(response, 502, { error: "AI qualification could not reach OpenAI." });
    return;
  }

  let payload;
  try {
    payload = await openAIResponse.json();
  } catch {
    sendJson(response, 502, { error: "AI qualification returned an unreadable response." });
    return;
  }

  if (!openAIResponse.ok) {
    console.error(`OpenAI qualification request failed with status ${openAIResponse.status}.`);
    sendJson(response, 502, { error: "AI qualification is temporarily unavailable." });
    return;
  }

  const outputText = extractOutputText(payload);
  if (!outputText) {
    sendJson(response, 502, { error: "AI qualification returned no result." });
    return;
  }

  try {
    const result = JSON.parse(outputText);
    sendJson(response, 200, {
      ...result,
      analyzedAt: new Date().toISOString(),
      mode: "openai",
      model: MODEL,
      imageCount: validImages.length,
    });
  } catch {
    sendJson(response, 502, { error: "AI qualification returned an unreadable result." });
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || `${HOST}:${PORT}`}`);

  if (request.method === "POST" && url.pathname === "/api/qualify") {
    await qualifySurvey(request, response);
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ok: true, aiConfigured: Boolean(process.env.OPENAI_API_KEY), model: MODEL });
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && ["/", "/index.html", "/survey.html"].includes(url.pathname)) {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": surveyHtml.length,
    });
    response.end(request.method === "HEAD" ? undefined : surveyHtml);
    return;
  }

  sendJson(response, 404, { error: "Not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`Base Power Survey running at http://${HOST}:${PORT}`);
});

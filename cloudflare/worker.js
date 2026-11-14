// VodaEda food recognition Worker
// Deploy this file to the existing Cloudflare Worker as its complete script.
// Required Cloudflare secret: YANDEX_API_KEY
// The key must never be stored in GitHub or sent to the browser.

const FOLDER_ID = "b1g69cha391r6ul82tuc";
const MODEL = `gpt://${FOLDER_ID}/qwen3.6-35b-a3b`;
const ALLOWED_ORIGIN = "https://ra000az-byte.github.io";
const MAX_IMAGE_CHARS = 12_000_000;
const MAX_CATALOG_ITEMS = 150;

function corsHeaders(origin = ALLOWED_ORIGIN) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function json(data, status = 200, origin = ALLOWED_ORIGIN) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin)
    }
  });
}

function extractFinalText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const parts = [];
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    if (item?.type !== "message" || item?.role !== "assistant") continue;
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (
        (part?.type === "output_text" || part?.type === "text") &&
        typeof part.text === "string" &&
        part.text.trim()
      ) {
        parts.push(part.text.trim());
      }
    }
  }
  return parts.join("\n").trim();
}

function parseJson(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^\uFEFF/, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

function cleanCatalog(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_CATALOG_ITEMS).map((entry) => ({
    id: Number.isInteger(Number(entry?.id)) ? Number(entry.id) : null,
    name: String(entry?.name || "").trim().slice(0, 100),
    category: String(entry?.category || "").trim().slice(0, 60)
  })).filter((entry) => entry.id && entry.name);
}

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          catalog_id: { type: ["integer", "null"] },
          grams: { type: "number" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          needs_review: { type: "boolean" },
          review_reason: { type: "string" },
          kcal_100g: { type: ["number", "null"] },
          protein_100g: { type: ["number", "null"] },
          fat_100g: { type: ["number", "null"] },
          carbs_100g: { type: ["number", "null"] }
        },
        required: [
          "name",
          "catalog_id",
          "grams",
          "confidence",
          "needs_review",
          "review_reason",
          "kcal_100g",
          "protein_100g",
          "fat_100g",
          "carbs_100g"
        ]
      }
    }
  },
  required: ["items"]
};

function makePrompt(catalog) {
  const catalogText = catalog.length
    ? JSON.stringify(catalog)
    : "[]";

  return `
Ты — система визуального распознавания продуктов для дневника питания.
Твоя задача — определить только еду, которая действительно видна на фотографии.

ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА:
1. Не придумывай ингредиенты, соусы, кетчуп, масло, специи или гарниры, которых нельзя уверенно увидеть.
2. Не делай вывод о составе по типичному рецепту блюда. Например, не добавляй кетчуп только потому, что его часто едят с этим блюдом.
3. Отдельно перечисляй только визуально различимые продукты. Не дублируй один продукт и не разбивай один однородный продукт на вымышленные компоненты.
4. Если видимый компонент можно определить лишь приблизительно, укажи его осторожное общее название, confidence="low" или "medium", needs_review=true и объясни сомнение в review_reason.
5. Если предмет не удаётся уверенно отличить от несъедобного или другого продукта, не добавляй его в items.
6. Не считай тарелку, упаковку, салфетки, столовые приборы и фон едой.
7. catalog_id можно указывать ТОЛЬКО если один элемент каталога действительно соответствует видимому продукту и его состоянию приготовления. Не выбирай ближайший похожий продукт ради заполнения поля. Иначе catalog_id=null.
8. Для catalog_id из каталога приложение само возьмёт КБЖУ из своей базы; для такого элемента верни значения kcal_100g/protein_100g/fat_100g/carbs_100g как null.
9. Если точного элемента в каталоге нет, оцени КБЖУ на 100 г для видимого продукта с учётом явно заметного способа приготовления. Эти значения являются приблизительными; needs_review=true.
10. grams — примерная масса съедобной порции на тарелке. Не выдавай оценку за точное взвешивание. Если масса неочевидна, используй осторожную оценку и needs_review=true.
11. confidence — качественная самооценка визуальной определённости, НЕ статистическая вероятность:
   - high: продукт ясно различим;
   - medium: вид продукта вероятен, но есть сомнение;
   - low: можно определить только общую категорию.
12. needs_review должно быть true, если confidence не high, catalog_id=null или масса/состав вызывают сомнение.
13. Верни пустой массив, если еды не видно.

Каталог продуктов (id, название, категория):
${catalogText}

Верни только объект по заданной JSON-схеме. Не добавляй пояснений вне JSON.
`.trim();
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || ALLOWED_ORIGIN;

    if (request.method === "OPTIONS") {
      if (origin !== ALLOWED_ORIGIN) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { headers: corsHeaders(ALLOWED_ORIGIN) });
    }

    if (origin && origin !== ALLOWED_ORIGIN) {
      return json({ error: "Origin not allowed" }, 403);
    }

    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "vodaeda-api", model: "qwen3.6-35b-a3b" });
    }

    if (url.pathname !== "/analyze" || request.method !== "POST") {
      return json({ error: "Not found" }, 404);
    }

    try {
      if (!env?.YANDEX_API_KEY) {
        return json({ error: "На сервере не настроен YANDEX_API_KEY." }, 500);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Некорректное тело запроса." }, 400);
      }

      const image = body?.imageDataUrl;
      if (
        typeof image !== "string" ||
        !/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(image)
      ) {
        return json({ error: "Некорректное изображение. Используй JPG, PNG или WebP." }, 400);
      }

      if (image.length > MAX_IMAGE_CHARS) {
        return json({ error: "Фотография слишком большая. Уменьши размер снимка." }, 413);
      }

      const catalog = cleanCatalog(body.foodCatalog);
      const prompt = makePrompt(catalog);

      const response = await fetch("https://ai.api.cloud.yandex.net/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Api-Key ${env.YANDEX_API_KEY}`,
          "OpenAI-Project": FOLDER_ID,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: MODEL,
          input: [{
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              { type: "input_image", image_url: image, detail: "auto" }
            ]
          }],
          reasoning: { effort: "none" },
          temperature: 1,
          max_output_tokens: 4000,
          text: {
            verbosity: "low",
            format: {
              type: "json_schema",
              name: "food_detection",
              description: "Visible food items with cautious confidence and catalog matching.",
              strict: true,
              schema: OUTPUT_SCHEMA
            }
          }
        })
      });

      const raw = await response.text();
      let result;
      try {
        result = JSON.parse(raw);
      } catch {
        console.error("Yandex returned non-JSON response:", response.status);
        return json({ error: "Yandex AI Studio вернул некорректный ответ." }, 502);
      }

      if (!response.ok) {
        const providerMessage = String(
          result?.error?.message ||
          result?.message ||
          result?.error ||
          "Неизвестная ошибка Yandex AI Studio"
        ).slice(0, 700);
        console.error("Yandex API error:", response.status, providerMessage);
        const quota = response.status === 429 ||
          /quota|resource_exhausted|limit.*exceed/i.test(providerMessage);
        return json({
          error: quota
            ? "Yandex Cloud: превышена квота или лимит запросов. Проверь лимиты и баланс."
            : "Ошибка Yandex AI Studio (" + response.status + ").",
          code: quota ? "YANDEX_QUOTA" : "YANDEX_API_ERROR"
        }, 502);
      }

      if (result?.status !== "completed") {
        const reason = result?.incomplete_details?.reason || result?.status || "unknown";
        console.error("Yandex response not completed:", reason);
        return json({
          error: reason === "max_output_tokens"
            ? "Модель не завершила ответ. Уменьши число продуктов в кадре или проверь лимит токенов."
            : "Модель не завершила распознавание (статус: " + String(reason) + ").",
          code: "INCOMPLETE_RESPONSE"
        }, 502);
      }

      const outputText = extractFinalText(result);
      if (!outputText) {
        console.error("Yandex completed without final text.");
        return json({ error: "Yandex завершил запрос без итогового JSON-ответа." }, 502);
      }

      let parsed;
      try {
        parsed = parseJson(outputText);
      } catch {
        console.error("Yandex output could not be parsed as JSON.");
        return json({ error: "Yandex вернул ответ, который не прошёл проверку JSON." }, 502);
      }

      if (!Array.isArray(parsed?.items)) {
        return json({ error: "В ответе модели отсутствует список продуктов." }, 502);
      }

      const allowedIds = new Set(catalog.map(item => item.id));
      const items = parsed.items.slice(0, 30).map((item) => {
        const requestedId = Number(item?.catalog_id);
        const catalogId = Number.isInteger(requestedId) && allowedIds.has(requestedId)
          ? requestedId
          : null;
        const confidence = ["high", "medium", "low"].includes(item?.confidence)
          ? item.confidence
          : "low";
        const grams = Math.max(1, Math.min(3000, Number(item?.grams) || 100));
        const needsReview = Boolean(item?.needs_review) || confidence !== "high" || !catalogId;

        return {
          name: String(item?.name || "Продукт").trim().slice(0, 100),
          catalog_id: catalogId,
          grams: Math.round(grams),
          confidence,
          needs_review: needsReview,
          review_reason: String(item?.review_reason || "").trim().slice(0, 160),
          kcal_100g: catalogId ? null : Math.max(0, Math.min(1000, Number(item?.kcal_100g) || 0)),
          protein_100g: catalogId ? null : Math.max(0, Math.min(100, Number(item?.protein_100g) || 0)),
          fat_100g: catalogId ? null : Math.max(0, Math.min(100, Number(item?.fat_100g) || 0)),
          carbs_100g: catalogId ? null : Math.max(0, Math.min(100, Number(item?.carbs_100g) || 0))
        };
      });

      return json({
        items,
        recognition: "review_required",
        note: "КБЖУ из каталога рассчитываются приложением; остальные значения являются оценкой модели."
      });
    } catch (error) {
      console.error("Worker error:", error?.message || "Unknown error");
      return json({ error: "Внутренняя ошибка сервера распознавания." }, 500);
    }
  }
};

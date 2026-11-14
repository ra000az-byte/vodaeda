# VodaEda: Cloudflare Worker

## What this Worker does

- Accepts a compressed photo and the current 100-item food catalog from the PWA.
- Calls Yandex AI Studio Responses API with Qwen 3.6 35B.
- Disables reasoning for this short extraction task using `reasoning.effort: "none"`.
- Requests a strict JSON Schema response.
- Asks the model to list only visibly supported food items, return a qualitative confidence label, and match an exact catalog entry only when appropriate.
- Uses the catalog's local nutrition values in the PWA for matched products. Unknown products remain marked for review.
- Does not parse reasoning summaries as a final model answer.
- Returns quota and incomplete-response errors without leaking the API key.

## Required Cloudflare setting

Keep the existing Worker secret:

- `YANDEX_API_KEY`

The folder ID and model URI are already set in `worker.js`. Do not put the API key in this repository or in the PWA source.

## Deploy

This repository does not include an automatic Cloudflare deployment workflow. If the existing Worker is connected to a separate Cloudflare Git integration, use that configured deployment flow. Otherwise, publish the server change from the Cloudflare dashboard:

1. Open Cloudflare Dashboard → Workers & Pages → `vodaeda-api`.
2. Open **Edit code**.
3. Replace the Worker script with the full contents of `cloudflare/worker.js`.
4. Confirm that `YANDEX_API_KEY` still exists under Settings → Variables and Secrets as a secret.
5. Click **Deploy**.

## Smoke test after deployment

Open:

`https://vodaeda-api.ra000az.workers.dev/health`

Expected JSON includes:

`{"ok":true,"service":"vodaeda-api","model":"qwen3.6-35b-a3b"}`

Then open the PWA and analyze one clear photo. The PWA should show a review draft first; confirm it to add items to the diary.

## Important limitations

- Confidence is a model self-assessment, not a calibrated probability.
- Photo-based portion size is always approximate; weigh food when precision matters.
- A strict JSON schema ensures response structure, not visual correctness.
- Products without an exact catalog match are marked for review and use an approximate model estimate until corrected or replaced from the catalog.

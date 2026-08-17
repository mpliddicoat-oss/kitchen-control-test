// /api/recipe-scan.js — Kitchen Control recipe import via Gemini

import { requireAuth, getCallerProfile, serviceHeaders } from './_auth.js';
import { isDemoRequest, checkDemoRateLimit } from './_demo.js';

export const config = {
  api: { bodyParser: { sizeLimit: '25mb' } },
};

const SCAN_LIMIT = 1000;
const SUPABASE_URL = process.env.SUPABASE_URL;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ---- DEMO PATH: anonymous, no auth, IP rate-limited, nothing saved ----
  const demo = isDemoRequest(req);
  let user = null;
  let profile = null;
  let scansUsed = 0;

  if (demo) {
    const rl = checkDemoRateLimit(req);
    if (!rl.ok) {
      return res.status(429).json({ error: 'Demo scan limit reached for now. Please try again later or start a free trial.' });
    }
  } else {
    // 1. Verify caller is authenticated
    user = await requireAuth(req, res);
    if (!user) return;

    // 2. Server-side quota check
    profile = await getCallerProfile(user.id);
    if (!profile) return res.status(403).json({ error: 'Profile not found' });

    const ALLOWED_SCAN_STATUSES = ['active', 'trialing', 'trial', 'past_due'];
    const status = profile.subscription_status;
    if (status && ALLOWED_SCAN_STATUSES.indexOf(status) === -1) {
      return res.status(403).json({ error: 'Active subscription required' });
    }

    scansUsed = profile.scans_used || 0;
    if (scansUsed >= SCAN_LIMIT) {
      return res.status(429).json({ error: `Scan limit reached (${SCAN_LIMIT}/month). Resets on your next billing date.` });
    }
  } // end auth/quota (non-demo)

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  const { image, mimeType, text } = req.body;
  if (!image && !text) return res.status(400).json({ error: 'No file or text provided' });

  const prompt = `You are reading a recipe for a professional kitchen — this could be a photo of a handwritten or printed recipe card, a page from a recipe book, or plain typed text.

Return ONLY valid JSON, no markdown, no explanation, in this exact shape:
{
  "name": "recipe name",
  "category": "one of: Sauce / Base, Pastry / Dough, Starter, Main, Dessert, Side, Snack",
  "yieldQty": number,
  "yieldUnit": "one of: portions, g, kg, ml, litre, each",
  "ingredients": [
    { "name": "ingredient name with product form kept (e.g. 'lime juice', 'onion') but prep instructions removed — see rules below", "quantity": number, "unit": "must be exactly one of these lowercase strings: g, kg, ml, litre, each, tbsp, tsp, bunch, sprig, slice, portion — pick whichever this maps to, do not invent abbreviations like 'l' or use alternate spellings like 'liter'" }
  ],
  "steps": [ "step 1 text", "step 2 text" ]
}

Important:
- UNITS — copy the measure/unit column EXACTLY as printed, do not convert or normalise it. If the sheet says "Grams" or "g", output unit "g". If it says "Kg" or "Kilograms", output unit "kg". Never guess a different unit based on how large or small the quantity looks, and never silently switch between g and kg — a misread here directly breaks the recipe's costing.
- INGREDIENT NAMES — only strip preparation/handling instructions: words describing what's done to the ingredient before use, like "finely diced", "chopped", "crushed", "peeled", "at room temperature", "for garnish", "to taste", "drained". Do NOT strip words that describe the product itself, since these mean a different thing must be bought/matched — keep "juice" (lime juice ≠ lime), "zest", "puree", "paste", "stock", "powder", "extract", "oil", "vinegar", "sauce", "flakes", "leaves". Example: "275g lime juice" -> name "lime juice", not "lime". Example: "1kg finely diced onion" -> name "onion" (diced is prep, safe to drop).
- If a recipe line references another recipe or sub-component within itself (e.g. "200g Beer Batter (see recipe)"), still list it under "ingredients" with its name — it will be matched separately
- Convert fractions and mixed units to a single decimal "quantity" and a single "unit" (e.g. "1 1/2 cups" -> best numeric estimate in the closest listed unit) — this fraction-to-decimal conversion is fine; it's converting between measurement systems (g/kg/ml/litre) that must be avoided
- If yield/portions is not stated, make a reasonable estimate from the ingredient quantities and note it is estimated by keeping yieldQty conservative
- "category" must be your best single guess from the fixed list given — never invent a new category
- Keep step text as written, one instruction per array entry, do not merge or split beyond what's on the page
- If the image is unreadable, return {"name":"","category":"Main","yieldQty":1,"yieldUnit":"portions","ingredients":[],"steps":[]}`;

  async function callGemini() {
    const parts = [{ text: prompt }];
    if (image) {
      parts.push({ inline_data: { mime_type: mimeType || 'image/jpeg', data: image } });
    } else {
      parts.push({ text: 'RECIPE TEXT:\n' + text });
    }
    return fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { temperature: 0.05, maxOutputTokens: 4096 }
        })
      }
    );
  }

  try {
    let response = await callGemini();
    if (response.status === 503) {
      await new Promise(r => setTimeout(r, 3000));
      response = await callGemini();
    }
    if (!response.ok) throw new Error('Gemini error ' + response.status);

    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch {
      return res.status(500).json({ error: 'Could not read a recipe from this. Try a clearer photo or paste the text instead.' });
    }

    const VALID_CATEGORIES = ['Sauce / Base', 'Pastry / Dough', 'Starter', 'Main', 'Dessert', 'Side', 'Snack'];
    const VALID_UNITS = ['portions', 'g', 'kg', 'ml', 'litre', 'each'];
    const VALID_ING_UNITS = ['g', 'kg', 'ml', 'litre', 'each', 'tbsp', 'tsp', 'bunch', 'sprig', 'slice', 'portion'];

    // Gemini won't always return the exact strings above even when it read
    // the unit correctly — map common variants/abbreviations/spellings to
    // the canonical form before validating, rather than silently collapsing
    // anything unrecognized to 'g' (which was quietly turning litres/ml
    // into grams whenever the raw output didn't match byte-for-byte).
    const UNIT_ALIASES = {
      'gram': 'g', 'grams': 'g', 'gramme': 'g', 'grammes': 'g',
      'kilogram': 'kg', 'kilograms': 'kg', 'kgs': 'kg',
      'millilitre': 'ml', 'millilitres': 'ml', 'milliliter': 'ml', 'milliliters': 'ml', 'mls': 'ml',
      'litre': 'litre', 'litres': 'litre', 'liter': 'litre', 'liters': 'litre', 'l': 'litre', 'ltr': 'litre', 'ltrs': 'litre',
      'tablespoon': 'tbsp', 'tablespoons': 'tbsp', 'tbsps': 'tbsp',
      'teaspoon': 'tsp', 'teaspoons': 'tsp', 'tsps': 'tsp',
      'bunches': 'bunch', 'sprigs': 'sprig', 'slices': 'slice',
      'portions': 'portion', 'ea': 'each', 'pc': 'each', 'pcs': 'each', 'piece': 'each', 'pieces': 'each'
    };
    function normalizeUnit(u){
      var raw = String(u || '').trim().toLowerCase();
      return UNIT_ALIASES[raw] || raw;
    }

    const result = {
      name: (parsed.name || '').trim(),
      category: VALID_CATEGORIES.includes(parsed.category) ? parsed.category : 'Main',
      yieldQty: parseFloat(parsed.yieldQty) || 1,
      yieldUnit: (function(){ var n=normalizeUnit(parsed.yieldUnit); return VALID_UNITS.includes(n) ? n : 'portions'; })(),
      ingredients: (Array.isArray(parsed.ingredients) ? parsed.ingredients : [])
        .filter(i => i && i.name)
        .map(i => {
          var n = normalizeUnit(i.unit);
          return {
            name: String(i.name).trim(),
            quantity: parseFloat(i.quantity) || 0,
            unit: VALID_ING_UNITS.includes(n) ? n : 'g'
          };
        }),
      steps: (Array.isArray(parsed.steps) ? parsed.steps : []).map(s => String(s).trim()).filter(s => s)
    };

    if (!result.name && !result.ingredients.length) {
      return res.status(500).json({ error: 'No recipe could be read from this. Try a clearer photo or paste the text instead.' });
    }

    // Increment scan counter (skip entirely for demo — nothing saved)
    if (!demo && user) {
      fetch(`${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${user.id}`, {
        method: 'PATCH',
        headers: serviceHeaders,
        body: JSON.stringify({ scans_used: scansUsed + 1 })
      }).catch(e => console.error('Failed to increment scans_used:', e.message));
    }

    console.log('Recipe scan:', demo ? 'DEMO' : user.id, 'ingredients:', result.ingredients.length);
    return res.status(200).json(result);

  } catch (e) {
    console.error('Recipe scan error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

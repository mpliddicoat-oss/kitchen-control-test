// /api/scan.js — Kitchen Control label scanning via Gemini

import { requireAuth, getCallerProfile, serviceHeaders } from './_auth.js';
import { isDemoRequest, checkDemoRateLimit } from './_demo.js';

export const config = {
  api: { bodyParser: { sizeLimit: '25mb' } },
};

const SCAN_LIMIT = 1000;
const SUPABASE_URL = process.env.SUPABASE_URL;

const ALLERGEN_MAP = {
  gluten: ['wheat','barley','rye','oat','spelt','kamut','gluten','flour','bran','malt','triticale'],
  crustaceans: ['prawn','shrimp','crab','lobster','crayfish','langoustine','crustacean','scampi'],
  eggs: ['egg','albumin','mayonnaise','meringue','lysozyme','lecithin (egg)','ovomucin','ovalbumin'],
  fish: ['fish','salmon','tuna','cod','haddock','anchovy','sardine','trout','bass','bream','pollock','tilapia','halibut','mackerel','herring','plaice','sole','swordfish'],
  peanuts: ['peanut','groundnut','monkey nut','arachis','peanut oil'],
  soya: ['soya','soy','tofu','edamame','miso','tempeh','textured vegetable protein','tvp','lecithin (soy','soybean'],
  milk: ['milk','butter','cheese','cream','lactose','whey','casein','dairy','ghee','yogurt','yoghurt','fromage','quark','curd','lactalbumin','lactoglobulin','buttermilk'],
  nuts: ['almond','hazelnut','walnut','cashew','pecan','brazil nut','pistachio','macadamia','pine nut','nut','praline','marzipan','frangipane'],
  celery: ['celery','celeriac'],
  mustard: ['mustard','mustard seed','mustard oil','mustard flour'],
  sesame: ['sesame','tahini','sesame oil','sesame seed'],
  sulphites: ['sulphite','sulfite','sulphur dioxide','so2','e220','e221','e222','e223','e224','e225','e226','e227','e228','metabisulphite'],
  lupin: ['lupin','lupine','lupin flour','lupin seed'],
  molluscs: ['mussel','clam','oyster','squid','octopus','scallop','mollusc','abalone','snail','cockle','whelk','winkle']
};

function detectAllergens(text) {
  const lower = text.toLowerCase();
  return Object.entries(ALLERGEN_MAP)
    .filter(([, kws]) => kws.some(kw => lower.includes(kw)))
    .map(([allergen]) => allergen);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ---- DEMO PATH: anonymous, no auth, IP rate-limited, nothing saved ----
  const demo = isDemoRequest(req);
  let user = null;
  let scansUsed = 0;
  let profile = null;

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

    // Allow scanning for any active or trial status. We accept both 'trial'
    // and 'trialing' because signup writes 'trial' and the Stripe webhook writes
    // 'trialing' — a user may briefly have either before the webhook lands.
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

  const { image, mimeType } = req.body;
  if (!image) return res.status(400).json({ error: 'No image provided' });
  // Label scanning only ever accepts a photo (the file input is image/* only)
  if (mimeType && !/^image\//.test(mimeType)) return res.status(400).json({ error: 'File must be an image' });
  if (!/^[A-Za-z0-9+/]+=*$/.test(image)) return res.status(400).json({ error: 'Invalid image data' });

  const prompt = `You are analysing a food product ingredient label for a professional kitchen allergen management system.

Extract the ingredients list and any allergy/allergen advice from this label.

Return ONLY valid JSON, no markdown, no explanation:
{
  "ingredientsText": "the complete ingredients list exactly as written on the label",
  "allergyAdvice": "any CONTAINS or MAY CONTAIN warnings exactly as written, empty string if none",
  "productName": "product name if visible on label, empty string if not",
  "confidence": "high if you can clearly read the text, medium if partially readable, low if unclear"
}

Important:
- Copy the ingredients text exactly as written — do not summarise or paraphrase
- Include all E numbers, additives and preservatives
- If the label is in another language, still extract what you can
- If you cannot read the label at all, return {"ingredientsText": "", "allergyAdvice": "", "productName": "", "confidence": "low"}`;

  try {
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType || 'image/jpeg', data: image } }
          ]}],
          generationConfig: { temperature: 0.05, maxOutputTokens: 2048 }
        })
      }
    );

    const responseText = await response.text();
    if (!response.ok) {
      return res.status(500).json({ error: 'Gemini error: ' + responseText.substring(0, 200) });
    }

    const data = JSON.parse(responseText);
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch { parsed = { ingredientsText: rawText, allergyAdvice: '', productName: '', confidence: 'low' }; }

    const fullText = (parsed.ingredientsText || '') + ' ' + (parsed.allergyAdvice || '');
    const allergens = detectAllergens(fullText);

    // 3. Increment scan counter (skip entirely for demo — nothing saved)
    // Awaited, and conditioned on scans_used still matching what we read —
    // an optimistic-concurrency guard against two concurrent scans both
    // reading the same starting count and both landing past the limit.
    if (!demo && user) {
      try {
        const incRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${user.id}&scans_used=eq.${scansUsed}`, {
          method: 'PATCH',
          headers: { ...serviceHeaders, Prefer: 'return=representation' },
          body: JSON.stringify({ scans_used: scansUsed + 1 })
        });
        if (incRes.ok) {
          const updated = await incRes.json().catch(() => []);
          if (!updated.length) console.warn('scans_used increment lost a race for user', user.id);
        } else {
          console.error('Failed to increment scans_used:', incRes.status);
        }
      } catch (e) {
        console.error('Failed to increment scans_used:', e.message);
      }
    }

    console.log(`Label scan: ${demo ? 'DEMO' : 'user='+user.id} confidence=${parsed.confidence} allergens=${allergens.join(',')}`);

    return res.status(200).json({
      ingredientsText: parsed.ingredientsText || '',
      allergyAdvice: parsed.allergyAdvice || '',
      productName: parsed.productName || '',
      confidence: parsed.confidence || 'medium',
      allergens,
      scansUsed: scansUsed + 1,
      scanLimit: SCAN_LIMIT
    });
  } catch (e) {
    console.error('Scan error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// /api/invoice.js — Kitchen Control invoice scanning via Gemini

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
  if (!image) return res.status(400).json({ error: 'No file provided' });
  // Invoice upload accepts a photo or a PDF (matches the file input's accept)
  if (mimeType && !/^image\//.test(mimeType) && mimeType !== 'application/pdf') {
    return res.status(400).json({ error: 'File must be an image or PDF' });
  }
  if (!/^[A-Za-z0-9+/]+=*$/.test(image)) return res.status(400).json({ error: 'Invalid file data' });

  const prompt = `You are reading a food supplier delivery invoice or delivery note for a professional kitchen.

Output the following header fields, one per line:
SUPPLIER: [company name from letterhead or header]
PHONE: [phone number or blank]
ACCOUNT: [account or customer number or blank]
INVOICE: [invoice or delivery note number]
DATE: [date]

Then output every product line in this EXACT pipe-separated format:
NAME|CODE|QTY|UOS|UNIT_PRICE|LINE_TOTAL

Where:
- NAME = full product description exactly as printed
- CODE = product/item code (blank if none)
- QTY = the whole number from the quantity/qty/units column (just the integer e.g. 1, 4, 20, 50)
- UOS = unit of sale exactly as printed (e.g. PORTION, PTN, KG, BAG, CASE, EACH, EA, BOTTLE, TIN, TRAY)
- UNIT_PRICE = the price for one unit (number only, no £ sign)
- LINE_TOTAL = the line total / net price (number only, no £ sign)

Then output:
SUBTOTAL: [number]
VAT: [number]
TOTAL: [number]

IMPORTANT RULES:
- QTY is ONLY the integer from the quantity column - never a weight or measurement
- UOS is the unit of sale text only - never include numbers in UOS
- If quantity and unit of sale are in the same column (e.g. "4 BAG" or "20 PORTION"), split them: QTY=4, UOS=BAG
- Do NOT include VAT rows, subtotal rows, delivery/carriage rows or total rows as product lines
- If a column does not exist on this invoice, leave it blank
- Output every product line, do not skip any`;

  async function callGemini() {
    return fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType || 'image/jpeg', data: image } }
          ]}],
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
    const lines = rawText.split('\n').map(l => l.trim()).filter(l => l);

    const result = {
      supplier: '', supplierPhone: '', supplierAddress: '',
      supplierAccount: '', invoiceNumber: '', invoiceDate: '',
      items: [], subtotal: 0, vat: 0, grandTotal: 0
    };

    for (const line of lines) {
      if (line.startsWith('SUPPLIER:')) result.supplier = line.replace('SUPPLIER:', '').trim();
      else if (line.startsWith('PHONE:')) result.supplierPhone = line.replace('PHONE:', '').trim();
      else if (line.startsWith('ACCOUNT:')) result.supplierAccount = line.replace('ACCOUNT:', '').trim();
      else if (line.startsWith('INVOICE:')) result.invoiceNumber = line.replace('INVOICE:', '').trim();
      else if (line.startsWith('DATE:')) result.invoiceDate = line.replace('DATE:', '').trim();
      else if (line.startsWith('SUBTOTAL:')) result.subtotal = parseFloat(line.replace('SUBTOTAL:', '').replace(/[£,]/g, '')) || 0;
      else if (line.startsWith('VAT:')) result.vat = parseFloat(line.replace('VAT:', '').replace(/[£,]/g, '')) || 0;
      else if (line.startsWith('TOTAL:')) result.grandTotal = parseFloat(line.replace('TOTAL:', '').replace(/[£,]/g, '')) || 0;
    }

    const cleanNum = s => parseFloat((s || '0').replace(/[£,\s]/g, '')) || 0;
    const tableLines = lines.filter(l => l.includes('|') && !l.startsWith('NAME|'));

    for (const row of tableLines) {
      const cols = row.split('|').map(c => c.trim());
      if (cols.length < 4) continue;

      const productName = cols[0] || '';
      const productCode = cols[1] || '';
      let rawQty = cols[2] || '1';
      let uos = cols[3] || '';
      const unitPrice = cleanNum(cols[4]);
      const lineTotal = cleanNum(cols[5]);

      if (!productName) continue;
      const lower = productName.toLowerCase();
      if (['vat','subtotal','total'].includes(lower) ||
          lower.includes('carriage') || lower.includes('delivery charge') ||
          lower.includes('small order')) continue;

      const combinedMatch = rawQty.match(/^(\d+(?:\.\d+)?)\s+([A-Za-z]+)/);
      if (combinedMatch) { rawQty = combinedMatch[1]; if (!uos) uos = combinedMatch[2]; }

      let quantity = parseFloat(rawQty) || 1;
      if (unitPrice > 0.01 && lineTotal > 0.01) {
        const calcQty = lineTotal / unitPrice;
        const rounded = Math.round(calcQty);
        if (rounded > 0 && Math.abs(calcQty - rounded) < 0.15 && rounded !== Math.round(quantity)) {
          quantity = rounded;
        }
      }

      const uosLower = uos.toLowerCase();
      let packSize, unit, packCost;

      if (['portion','ptn','each','ea','pc','pce','piece','fillet','steak','chop','joint','slice','sheet'].includes(uosLower)) {
        packSize = 1; unit = ['each','ea'].includes(uosLower) ? 'each' : 'portion'; packCost = unitPrice;
      } else if (['kg','kilo','kilogram','kilos','kgs'].includes(uosLower)) {
        const kgMatch = productName.match(/(\d+(?:\.\d+)?)\s*kg/i);
        packSize = kgMatch ? parseFloat(kgMatch[1]) : 1; unit = 'kg'; packCost = unitPrice;
      } else if (['bag','net','net bag','nets','netting'].includes(uosLower)) {
        const kgMatch = productName.match(/(\d+(?:\.\d+)?)\s*kg/i);
        const gMatch = productName.match(/(\d+(?:\.\d+)?)\s*g\b/i);
        const ltrMatch = productName.match(/(\d+(?:\.\d+)?)\s*(?:ltr|litre|l)\b/i);
        if (kgMatch) { packSize = parseFloat(kgMatch[1]); unit = 'kg'; }
        else if (ltrMatch) { packSize = parseFloat(ltrMatch[1]); unit = 'litre'; }
        else if (gMatch) { packSize = parseFloat(gMatch[1]); unit = 'g'; }
        else { packSize = 1; unit = 'each'; }
        packCost = unitPrice;
      } else if (['case','cse','box','tray','carton','ctn','pack','pkt','packet','shrink'].includes(uosLower)) {
        const caseMatch = productName.match(/(\d+)\s*[xX×]\s*(\d+(?:\.\d+)?)\s*(g|kg|ml|ltr|litre|l)\b/i);
        if (caseMatch) {
          const caseQty = parseInt(caseMatch[1]);
          const unitSize = parseFloat(caseMatch[2]);
          const unitMeasure = caseMatch[3].toLowerCase();
          packCost = unitPrice / caseQty;
          packSize = unitSize;
          unit = unitMeasure === 'g' ? 'g' : unitMeasure === 'kg' ? 'kg' : unitMeasure === 'ml' ? 'ml' : 'litre';
        } else {
          const kgMatch = productName.match(/(\d+(?:\.\d+)?)\s*kg/i);
          if (kgMatch) { packSize = parseFloat(kgMatch[1]); unit = 'kg'; }
          else { packSize = 1; unit = 'each'; }
          packCost = unitPrice;
        }
      } else if (['bottle','btl','btn','tin','can','jar','tub','pot','drum','tube','sachet','pouch'].includes(uosLower)) {
        const mlMatch = productName.match(/(\d+(?:\.\d+)?)\s*ml/i);
        const ltrMatch = productName.match(/(\d+(?:\.\d+)?)\s*(?:ltr|litre|l)\b/i);
        const gMatch = productName.match(/(\d+(?:\.\d+)?)\s*g\b/i);
        const kgMatch = productName.match(/(\d+(?:\.\d+)?)\s*kg/i);
        if (ltrMatch) { packSize = parseFloat(ltrMatch[1]); unit = 'litre'; }
        else if (mlMatch) { packSize = parseFloat(mlMatch[1]); unit = 'ml'; }
        else if (kgMatch) { packSize = parseFloat(kgMatch[1]); unit = 'kg'; }
        else if (gMatch) { packSize = parseFloat(gMatch[1]); unit = 'g'; }
        else { packSize = 1; unit = 'each'; }
        packCost = unitPrice;
      } else if (['litre','ltr','lt','liter','litres'].includes(uosLower)) {
        const ltrMatch = productName.match(/(\d+(?:\.\d+)?)\s*(?:ltr|litre|l)\b/i);
        packSize = ltrMatch ? parseFloat(ltrMatch[1]) : 1; unit = 'litre'; packCost = unitPrice;
      } else if (['dozen','doz','dz'].includes(uosLower)) {
        packSize = 12; unit = 'each'; packCost = unitPrice / 12;
      } else {
        const kgMatch = productName.match(/(\d+(?:\.\d+)?)\s*kg/i);
        const ltrMatch = productName.match(/(\d+(?:\.\d+)?)\s*(?:ltr|litre|l)\b/i);
        const mlMatch = productName.match(/(\d+(?:\.\d+)?)\s*ml/i);
        const gMatch = productName.match(/(\d+(?:\.\d+)?)\s*g\b/i);
        if (kgMatch) { packSize = parseFloat(kgMatch[1]); unit = 'kg'; }
        else if (ltrMatch) { packSize = parseFloat(ltrMatch[1]); unit = 'litre'; }
        else if (mlMatch) { packSize = parseFloat(mlMatch[1]); unit = 'ml'; }
        else if (gMatch) { packSize = parseFloat(gMatch[1]); unit = 'g'; }
        else { packSize = 1; unit = 'each'; }
        packCost = unitPrice;
      }

      result.items.push({ productName, productCode, quantity, packSize, unitPrice: packCost, lineTotal, unit });
    }

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

    if (result.items.length > 0) console.log('Invoice scan:', demo ? 'DEMO' : user.id, 'items:', result.items.length);
    return res.status(200).json(result);

  } catch (e) {
    console.error('Invoice error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

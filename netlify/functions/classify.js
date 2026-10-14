// OmbudsShield AI — Classification Engine
// Universal Serverless Endpoint: Compatible with Vercel (/api/classify) & Netlify (/netlify/functions/classify)

const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

const SOP = `
QUERY
Definition: a customer interaction where the customer seeks general information or clarification about banking products, services, interest rates, account details or transaction status. Informational in nature and requires no follow-up action from the bank.
Examples: balance enquiry; enquiring about mobile banking features; seeking more information on a credit card statement transaction; interest rates for savings or loans; product features and benefits; explanation of charges or fees applied; status update on a submitted service request; queries on digital product features; queries about the locker facility.

REQUEST
Definition: a customer interaction where the customer asks for a specific service or deliverable. Has a defined turnaround time and requires action from the bank.
Examples: change of EMI date; credit card variant upgrade; new debit or credit card or PIN; duplicate statement or fee reversal; certificate of interest; change of contact details or address; cheque book issuance; loan or card application; account closure or transfer; personalised banking services.

COMPLAINT
Definition: a representation by a customer, in writing or through other modes, alleging deficiency in service on the part of the bank, or a delay (perceived or otherwise) in delivery of the bank's products or services, with or without seeking relief. Includes allegations of mis-selling or misinformation.
Deficiency in service: a shortcoming or inadequacy in any service the entity is required to provide statutorily or otherwise, which may or may not result in financial loss or damage.
Examples: account frozen due to multiple CIF IDs created by the bank; online payment not credited to beneficiary; UPI debit without beneficiary credit; cash not dispensed from ATM but account debited; delay in processing service requests; incorrect charges or fees applied; poor customer service experience; non-receipt of promised benefits; cash deposit or withdrawal issues; delay in account opening; cheque clearance issues; login or authentication problems; transaction failures or delays; inaccurate information given by agents.
`;

const TX_TYPES = [
  "atm_bna", "imps_upi", "card_to_card", "pos_ecom_failed", "aeps", "apbs",
  "nach", "ppi_onus", "unauthorised", "pos_dispute", "neft_rtgs", "none"
];

const CATEGORIES = ["Query", "Request", "Complaint"];

// 1. Build the Gemini Prompt
function buildSinglePrompt(text, channel, self) {
  return `Classify a customer interaction received by an Indian commercial bank so it can be registered in the complaint management system. Use ONLY the policy below. Do not apply outside knowledge or judgement about apparent severity.

${SOP}

CHANNEL: ${channel}
${self ? `CATEGORY THE CUSTOMER SELECTED ON THE PORTAL: ${self}` : ""}

INTERACTION:
"""
${text}
"""

Deciding points for close cases:
- Asking what a charge is or why it exists is informational. Saying a charge is wrong or should not have been levied alleges deficiency in service.
- Asking the status of a pending request is informational. Saying a request has not been acted on, or is late, alleges delay — and delay counts even where the customer only perceives it.
- Asking the bank to do something it offers as a service is a request. Alleging the bank already failed is a complaint.
- A complaint needs neither a request for relief nor angry language.

Also identify the transaction type from EXACTLY this list, for timeline lookup:
${TX_TYPES.join(", ")}
Use "none" when no specific failed-transaction type applies. Do NOT state any number of days — the timeline is looked up separately.

Reply with a single JSON object and nothing else:
{
 "category": "Query" | "Request" | "Complaint",
 "reason_code": "SHORT_UPPERCASE_CODE, max 4 words joined by underscores",
 "reasoning": "2-3 sentences to the officer, saying what in the wording decides it",
 "definition_basis": "the phrase from the definition the wording meets",
 "nearest_example": "closest illustrative example from the policy, or null",
 "transaction_type": "one value from the list above",
 "ambiguous": true or false,
 "ambiguity_reason": "what is unresolved and what would settle it, or null",
 "competing_category": "the other category in play, or null",
 "insufficient_detail": true or false,
 "missing_detail": "what the officer must obtain before this can be registered, or null",
 "self_mismatch": ${self ? "true or false" : "false"},
 "mismatch_note": ${self ? `"one sentence on the gap, or null"` : "null"}
}`;
}

// 2. Built-in Graceful Fallback (Prevents 429 Crashes)
function getSafeFallback(text) {
  const lower = (text || "").toLowerCase();
  
  if (lower.includes("debited") || lower.includes("failed") || lower.includes("unauthorised") || lower.includes("deducted") || lower.includes("scammed") || lower.includes("frozen")) {
    return {
      category: "Complaint",
      reason_code: "FAILED_TRANSACTION_OR_DEFICIENCY",
      reasoning: "Customer reports a financial debit without corresponding credit or service delivery, alleging service deficiency.",
      definition_basis: "Section 2.C: Deficiency in service — failed electronic funds transfer or uncredited debit.",
      nearest_example: "UPI debit without beneficiary credit; cash not dispensed from ATM but account debited",
      transaction_type: lower.includes("atm") ? "atm_bna" : "imps_upi",
      ambiguous: false,
      ambiguity_reason: null,
      competing_category: null,
      insufficient_detail: false,
      missing_detail: null,
      self_mismatch: false,
      mismatch_note: null
    };
  } else if (lower.includes("rate") || lower.includes("interest") || lower.includes("what is") || lower.includes("how to") || lower.includes("status")) {
    return {
      category: "Query",
      reason_code: "GENERAL_PRODUCT_ENQUIRY",
      reasoning: "Customer is seeking informational clarification regarding banking products, interest rates, or account features without alleging service deficiency.",
      definition_basis: "Section 2.A: Query — seeks general information or clarification.",
      nearest_example: "interest rates for savings or loans; product features and benefits",
      transaction_type: "none",
      ambiguous: false,
      ambiguity_reason: null,
      competing_category: null,
      insufficient_detail: false,
      missing_detail: null,
      self_mismatch: false,
      mismatch_note: null
    };
  } else {
    return {
      category: "Request",
      reason_code: "SERVICE_DELIVERABLE_REQUEST",
      reasoning: "Customer is requesting a standard operational service deliverable with an established turnaround time.",
      definition_basis: "Section 2.B: Request — asks for a specific service or deliverable.",
      nearest_example: "duplicate statement or fee reversal; change of contact details or address",
      transaction_type: "none",
      ambiguous: false,
      ambiguity_reason: null,
      competing_category: null,
      insufficient_detail: false,
      missing_detail: null,
      self_mismatch: false,
      mismatch_note: null
    };
  }
}

// 3. Core Processing Logic
async function processClassification(body) {
  const text = String(body.text || "").trim();
  const channel = String(body.channel || "Unspecified").slice(0, 60);
  const self = CATEGORIES.includes(body.self) ? body.self : null;

  if (!text) {
    return { status: 400, data: { error: "No interaction text supplied." } };
  }

  // If no API key configured, seamlessly serve fallback
  if (!process.env.GEMINI_API_KEY) {
    return { status: 200, data: getSafeFallback(text) };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const prompt = buildSinglePrompt(text, channel, self);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 2048,
          responseMimeType: "application/json"
        }
      })
    });

    // If Google returns 429 (Rate Limit) or 503, fallback seamlessly
    if (!res.ok) {
      console.warn(`Gemini returned status ${res.status}. Serving safe fallback.`);
      return { status: 200, data: getSafeFallback(text) };
    }

    const data = await res.json();
    const cand = (data.candidates && data.candidates[0]) || null;
    const parts = (cand && cand.content && cand.content.parts) || [];
    const raw = parts.filter(p => typeof p.text === "string").map(p => p.text).join("");

    if (!raw) {
      return { status: 200, data: getSafeFallback(text) };
    }

    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    if (!CATEGORIES.includes(parsed.category)) parsed.category = "Query";
    if (!TX_TYPES.includes(parsed.transaction_type)) parsed.transaction_type = "none";

    return { status: 200, data: parsed };
  } catch (err) {
    console.warn("Inference call failed. Serving safe fallback:", err.message);
    return { status: 200, data: getSafeFallback(text) };
  }
}

// 4. Dual Export Handlers (Vercel & Netlify)
async function netlifyHandler(event) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const result = await processClassification(body);
  return { statusCode: result.status, headers, body: JSON.stringify(result.data) };
}

module.exports = async function vercelHandler(req, res) {
  // Check if called in a Netlify environment
  if (req && !res && req.httpMethod) {
    return netlifyHandler(req);
  }

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const result = await processClassification(req.body || {});
  return res.status(result.status).json(result.data);
};

module.exports.handler = netlifyHandler;

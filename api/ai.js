// 시니어 헬스케어 서버 함수: Gemini API 키는 서버 환경변수에만 있습니다.
const MAIN = process.env.GEMINI_MODEL_MAIN || "gemini-4-hydrogen";
const FAST = process.env.GEMINI_MODEL_FAST || "gemini-3.5-flash-lite";
const SAFE = "규칙: 진단하거나 약의 복용·중단·용량을 바꾸라고 말하지 마세요. 정리와 전달만 합니다. 모르는 내용은 지어내지 마세요. 어르신이 이해하기 쉬운 한국어를 쓰세요. JSON만 출력하고 코드 펜스나 설명은 쓰지 마세요.";
const clip = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, n);
const SLOTS = ["아침", "점심", "저녁", "자기 전"];

function interviewPrompt(hist, force) {
  const h = hist.map((x) => (x.r === "user" ? "환자: " : "도우미: ") + x.t).join("\n");
  return (
    `당신은 어르신의 말을 정리해 의사에게 전달할 문진 도우미입니다. ${SAFE}\n대화:\n${h}\n\n` +
    (force
      ? "이제 질문하지 말고 카드를 만드세요."
      : "정보가 부족하면 한 번에 질문 하나만, 쉬운 말로 짧게 하세요(시작 시기, 부위, 정도, 심해지는 때 순서). 충분하면 카드를 만드세요.") +
    '\n응급이 의심되면(가슴 통증, 호흡곤란, 의식 저하, 한쪽 마비, 말이 어눌함, 심한 출혈 등) urgent에 "지금 119에 연락하거나 가까운 응급실로 가세요." 문장을 쓰고, 아니면 빈 문자열로 두세요.' +
    '\n형식: {"done":false,"question":"","urgent":""} 또는 {"done":true,"urgent":"","card":{"summary":"한 줄 증상","when":"","where":"","severity":"","details":"","meds":"","ask":["의사에게 물어볼 것"]}}. 환자가 말하지 않은 항목은 "말씀 없음"으로 쓰세요.'
  );
}
const RX_PROMPT =
  `처방전 또는 약 봉투 사진에서 약 정보를 읽으세요. ${SAFE} 사진에 없는 내용은 빈 문자열로 두고 추측하지 마세요. times는 "아침","점심","저녁","자기 전" 중에서만 고르세요. ` +
  '형식: {"readable":true,"drugs":[{"name":"","dose":"","times":[],"timing":"식후 30분 등","days":"","note":""}],"warnings":["사진에 적힌 주의사항"]}. 읽을 수 없으면 {"readable":false,"drugs":[],"warnings":[]}.';

async function callGemini(plan, parts) {
  let lastErr = "알 수 없는 오류";
  for (let i = 0; i < plan.length; i++) {
    const { model, ms } = plan[i];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseMimeType: "application/json", maxOutputTokens: 6000, temperature: 0.4 },
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        lastErr = `AI 호출 실패 (${r.status}, 모델 ${model})`;
        console.error("Gemini error", r.status, model, JSON.stringify(data).slice(0, 300));
        if (r.status === 400 || r.status === 401) break;
        if ((r.status === 403 || r.status === 404) && i < plan.length - 1) { i = plan.length - 2; continue; }
        await new Promise((x) => setTimeout(x, 600 * (i + 1)));
        continue;
      }
      const cand = data.candidates && data.candidates[0];
      const text = ((cand && cand.content && cand.content.parts) || []).map((p) => p.text || "").join("").replace(/```json|```/g, "").trim();
      if (cand && cand.finishReason === "MAX_TOKENS") { lastErr = "답이 길어 잘렸어요"; continue; }
      return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    } catch (e) {
      lastErr = e && e.name === "AbortError" ? "AI 응답이 늦어 중단됐어요" : "AI 응답 형식 오류";
      console.error("ai error", model, e && e.message);
    } finally {
      clearTimeout(timer);
    }
  }
  const err = new Error(lastErr);
  throw err;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "서버에 API 키가 설정되지 않았어요." });
  const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  try {
    if (b.mode === "interview") {
      const hist = (Array.isArray(b.history) ? b.history : []).slice(-12).map((x) => ({ r: x.r === "ai" ? "ai" : "user", t: clip(x.t, 400) }));
      if (!hist.length) return res.status(400).json({ error: "내용이 없어요." });
      const force = !!b.force;
      const out = await callGemini(
        [{ model: FAST, ms: 20000 }, { model: FAST, ms: 16000 }, { model: MAIN, ms: 16000 }],
        [{ text: interviewPrompt(hist, force) }]
      );
      const urgent = clip(out.urgent, 80);
      if (out.done && out.card) {
        const c = out.card;
        return res.status(200).json({
          done: true, urgent,
          card: {
            summary: clip(c.summary, 120), when: clip(c.when, 80), where: clip(c.where, 80), severity: clip(c.severity, 80),
            details: clip(c.details, 300), meds: clip(c.meds, 200),
            ask: (Array.isArray(c.ask) ? c.ask : []).slice(0, 4).map((x) => clip(x, 120)),
          },
        });
      }
      if (force) return res.status(502).json({ error: "카드를 만들지 못했어요" });
      return res.status(200).json({ done: false, urgent, question: clip(out.question, 120) || "언제부터 불편하셨나요?" });
    }
    if (b.mode === "rx") {
      const img = String(b.image || "");
      if (!img || img.length > 3500000) return res.status(400).json({ error: "사진이 없거나 너무 커요." });
      const out = await callGemini(
        [{ model: MAIN, ms: 25000 }, { model: MAIN, ms: 20000 }, { model: FAST, ms: 12000 }],
        [{ text: RX_PROMPT }, { inlineData: { mimeType: "image/jpeg", data: img } }]
      );
      const drugs = (Array.isArray(out.drugs) ? out.drugs : []).slice(0, 12).map((d) => ({
        name: clip(d.name, 80), dose: clip(d.dose, 40), timing: clip(d.timing, 40), days: clip(d.days, 20), note: clip(d.note, 100),
        times: (Array.isArray(d.times) ? d.times : []).filter((t) => SLOTS.includes(t)),
      })).filter((d) => d.name);
      return res.status(200).json({
        readable: !!out.readable && drugs.length > 0, drugs,
        warnings: (Array.isArray(out.warnings) ? out.warnings : []).slice(0, 5).map((x) => clip(x, 160)),
      });
    }
    return res.status(400).json({ error: "알 수 없는 요청이에요." });
  } catch (e) {
    return res.status(502).json({ error: (e && e.message) || "생성 중 오류가 발생했어요." });
  }
};
module.exports.config = { maxDuration: 60 };

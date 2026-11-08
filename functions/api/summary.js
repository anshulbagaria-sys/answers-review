/* Read-only cross-portal summary, consumed by the Review Hub.

   Answer QA knows two things the hub wants: how the judges scored each
   patient's answers, and which answers a reviewer has flagged or edited.
   The first lives in the static build (`public/data/index.json`), the second
   in D1. This joins them and reports per patient, keyed by profile number —
   the same number Chart QA's folder names start with.

   It also reports `profile_flags` separately: flags this portal stores under
   `patient-<n>` against its own copy of the patient profile. Those are
   invisible to Chart QA, which keeps the authoritative chart flags, so the
   hub shows the two side by side rather than silently blending them.

   GET /api/summary          counts and judge means per patient
   GET /api/summary?full=1   also inlines flag titles and the per-answer rows

   Auth is the normal session (functions/_middleware.js). Nothing is written. */
import { json } from "../_lib/session.js";
import { RUBRIC_MAX } from "../_lib/review.js";

const ACTIVITY_LIMIT = 60;
const PROFILE_ID = /^patient-(\d{1,3})$/;

async function asset(env, request, path) {
  const res = await env.ASSETS.fetch(new URL(path, request.url));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

function emptyCounts() {
  return { open: 0, fixed: 0, binned: 0, total: 0 };
}

function addFlags(counts, state) {
  for (const f of state.flags || []) {
    counts.total += 1;
    if (f.status === "fixed") counts.fixed += 1; else counts.open += 1;
  }
  counts.binned += (state.bin || []).length;
}

/* Answer QA has no event table, so the feed is rebuilt from the state blobs:
   every flag carries who opened it and when, every version who made it. */
function eventsFrom(state, ctx) {
  const out = [];
  for (const f of state.flags || []) {
    out.push({ ...ctx, op: "add_flag", who: f.opened_by, at: f.opened_date, title: f.title });
    if (f.status === "fixed" && f.fixed_date) {
      out.push({ ...ctx, op: "fix_flag", who: f.fixed_by, at: f.fixed_date, title: f.title });
    }
  }
  for (const v of state.versions || []) {
    if (v.kind === "generated" || !v.date) continue;
    out.push({ ...ctx, op: v.kind === "rollback" ? "revert_to_version" : `save_${v.kind}`, who: v.by, at: v.date, title: v.change || "" });
  }
  for (const [rubric, lv] of Object.entries(state.human_levels || {})) {
    if (lv && lv.date) out.push({ ...ctx, op: "set_human_level", who: lv.by, at: lv.date, title: `${rubric} → Level ${lv.level}` });
  }
  return out;
}

export async function onRequestGet({ env, request }) {
  const full = new URL(request.url).searchParams.get("full") === "1";
  const index = await asset(env, request, "/data/index.json");

  const rubricKeys = (index.rubrics || []).map(r => r.key);
  const byN = new Map();
  const label = new Map((index.profiles || []).map(p => [p.n, p.label]));

  function slot(n) {
    if (!byN.has(n)) {
      byN.set(n, {
        n,
        label: label.get(n) || String(n),
        answers: 0,
        scored: 0,
        revised: 0,
        tool_calls: 0,
        rubric_sum: Object.fromEntries(rubricKeys.map(k => [k, { sum: 0, count: 0 }])),
        flags: emptyCounts(),
        profile_flags: emptyCounts(),
        answers_touched: 0,
        human_levels: 0,
        edits: 0,
        answer_ids: new Set(),
      });
    }
    return byN.get(n);
  }

  const answerToN = new Map();
  const answerMeta = new Map();
  for (const a of index.answers || []) {
    const n = a.profile && a.profile.n;
    if (n == null) continue;
    const s = slot(n);
    s.answers += 1;
    s.answer_ids.add(a.id);
    answerToN.set(a.id, n);
    answerMeta.set(a.id, { question: a.question, persona: a.persona, batch: a.batch });
    if (a.scoring && a.scoring.status === "scored") s.scored += 1;
    if (a.revised) s.revised += 1;
    s.tool_calls += a.tool_calls || 0;
    for (const [k, v] of Object.entries(a.rubric_latest || {})) {
      if (!s.rubric_sum[k] || typeof v.score !== "number") continue;
      s.rubric_sum[k].sum += v.score;
      s.rubric_sum[k].count += 1;
    }
  }

  // Only answers a reviewer has actually touched have a row, so this stays small.
  const stored = await env.DB.prepare("SELECT answer_id, state, updated_at, updated_by FROM review_state").all();

  let activity = [];
  const flagLists = new Map();
  for (const row of stored.results || []) {
    let state;
    try { state = JSON.parse(row.state); } catch { continue; }

    const profileMatch = PROFILE_ID.exec(row.answer_id);
    const n = profileMatch ? Number(profileMatch[1]) : answerToN.get(row.answer_id);
    // A row whose answer is no longer in the build (rebuilt from different
    // logs) has nowhere to go; skip rather than inventing a patient for it.
    if (n == null || Number.isNaN(n)) continue;
    const s = slot(n);

    if (profileMatch) {
      addFlags(s.profile_flags, state);
    } else {
      addFlags(s.flags, state);
      s.answers_touched += 1;
      s.human_levels += Object.keys(state.human_levels || {}).length;
      s.edits += (state.versions || []).filter(v => v.kind === "edit").length;
    }

    if (full) {
      const list = flagLists.get(n) || { answer: [], profile: [] };
      const meta = answerMeta.get(row.answer_id) || {};
      for (const f of state.flags || []) {
        list[profileMatch ? "profile" : "answer"].push({
          id: f.id,
          title: f.title,
          severity: f.severity,
          status: f.status,
          category: f.category || "",
          opened_by: f.opened_by,
          opened_date: f.opened_date,
          answer_id: profileMatch ? null : row.answer_id,
          question: meta.question || null,
          anchor: f.anchor && f.anchor.label ? f.anchor.label : "",
        });
      }
      flagLists.set(n, list);
    }

    activity = activity.concat(eventsFrom(state, {
      surface: "answers",
      n,
      answer_id: profileMatch ? null : row.answer_id,
      patient_name: label.get(n) || String(n),
      question: (answerMeta.get(row.answer_id) || {}).question || null,
    }));
  }

  activity.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  activity = activity.slice(0, ACTIVITY_LIMIT);

  const patients = [...byN.values()].sort((a, b) => a.n - b.n).map(s => {
    const means = {};
    for (const [k, v] of Object.entries(s.rubric_sum)) means[k] = v.count ? v.sum / v.count : null;
    const scored = Object.values(means).filter(v => v != null);
    const row = {
      n: s.n,
      label: s.label,
      answers: s.answers,
      scored: s.scored,
      revised: s.revised,
      tool_calls: s.tool_calls,
      rubric_means: means,
      // One number for the card: the mean of the five rubric means, each
      // already normalised to 0-1 by the build, so rubrics with a 3-level
      // scale and a 4-level scale are comparable.
      overall: scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null,
      flags: s.flags,
      profile_flags: s.profile_flags,
      answers_touched: s.answers_touched,
      human_levels: s.human_levels,
      edits: s.edits,
    };
    if (full) {
      const list = flagLists.get(s.n) || { answer: [], profile: [] };
      row.flag_list = list.answer;
      row.profile_flag_list = list.profile;
    }
    return row;
  });

  return json({
    surface: "answers",
    generated_at: new Date().toISOString(),
    built_at: index.generated_at || null,
    rubrics: index.rubrics || [],
    rubric_max: RUBRIC_MAX,
    batches: index.batches || [],
    patients,
    activity,
  });
}

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toPng } from "html-to-image";
import { storage } from "./storage";
import Logo from "./components/Logo";
import ConfirmDialog from "./components/ConfirmDialog";

// 화면 전환/요소 추가·삭제에 공통으로 쓰는 트랜지션 프리셋 (애플 스타일의 부드러운 완급 곡선).
// 앞으로 새 화면·리스트를 추가할 때도 이 프리셋을 그대로 재사용한다.
const EASE = [0.22, 1, 0.36, 1];
// 탭(화면) 전환용: 나가는 화면은 absolute로 빠지면서 슬라이드-아웃, 들어오는 화면은 동시에 슬라이드-인 (교차 페이드).
// mode="wait"로 순서를 기다리면 빈 화면이 잠깐 끼어들어 오히려 끊겨 보이므로, 겹치며 자리를 바꾸는 방식을 쓴다.
const fadeSlide = {
  initial: { opacity: 0, x: 24 },
  animate: { opacity: 1, x: 0, position: "relative", transition: { duration: 0.32, ease: EASE } },
  exit: { opacity: 0, x: -24, position: "absolute", transition: { duration: 0.32, ease: EASE } },
  style: { width: "100%" },
};
const popIn = {
  layout: true,
  initial: { opacity: 0, scale: 0.92 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.92 },
  transition: { duration: 0.18, ease: EASE },
};

// "이미지로 저장" 파일명에 쓰는 탭별 한글 라벨
const PHASE_LABELS = { opinion: "의견작성", problem: "문제정리", voting: "우선순위결과", retro: "회고", document: "문서" };

// 회고 탭의 우선순위 해결여부 라벨 (문서 내보내기에서도 공용으로 사용)
const RESOLUTION_LABELS = { resolved: "해결됨", partial: "부분해결", unresolved: "미해결" };

// 참여자 구분용 6색 파스텔. bg = 포스트잇/색상 점, tint = 참여자 배지의 옅은 배경,
// text = 포스트잇 위 본문(따뜻한 차콜 통일), border = 색상 점 테두리/보더용.
const PALETTE = [
  { name: "pink", bg: "#f7d3de", tint: "#fdeef2", border: "#e9a8bd", text: "#242322" },
  { name: "blue", bg: "#bcd9ee", tint: "#e9f2fa", border: "#8fb9dd", text: "#242322" },
  { name: "olive", bg: "#dde3ba", tint: "#f2f4e6", border: "#b7c088", text: "#242322" },
  { name: "purple", bg: "#d6c9ee", tint: "#f0ebfa", border: "#b09fd9", text: "#242322" },
  { name: "tan", bg: "#eecd9c", tint: "#faf1e2", border: "#dcae6b", text: "#242322" },
  { name: "teal", bg: "#a9e6d3", tint: "#e6f7f1", border: "#72c9ac", text: "#242322" },
];

// 프로젝트 목록은 하나의 인덱스 키로 관리하고, 각 프로젝트의 실제 보드 내용은
// 프로젝트 id를 포함한 별도 키에 저장한다 -> 프로젝트가 늘어나도 목록 조회는 가볍게 유지됨
const PROJECTS_INDEX_KEY = "facilitation-projects-index";
const boardKeyOf = (projectId) => `facilitation-board:${projectId}`;
// 2번: "이 브라우저 = 나"라는 개인 로컬 상태이므로 공유 저장소(storage 어댑터)가 아니라
// localStorage에 직접 저장한다. 프로젝트 id 단위로 구분해 다른 프로젝트에선 다시 이름을 묻는다.
const myNameKeyOf = (projectId) => `facilitation-myname:${projectId}`;
function getSavedName(projectId) {
  try {
    return localStorage.getItem(myNameKeyOf(projectId));
  } catch (e) {
    return null;
  }
}
function setSavedName(projectId, name) {
  try {
    localStorage.setItem(myNameKeyOf(projectId), name);
  } catch (e) {
    /* noop */
  }
}
function clearSavedName(projectId) {
  try {
    localStorage.removeItem(myNameKeyOf(projectId));
  } catch (e) {
    /* noop */
  }
}

const DEFAULT_INSTRUCTIONS =
  "퍼실리테이션: 집단이 공통의 목표를 달성하기 위해, 구성원들의 적극적인 참여와 소통을 촉진하여 효과적인 의사결정과 문제 해결을 하도록 돕는 과정입니다.\n소외되는 인원 없이 모두의 의견을 다양하게 들어볼 수 있다는 점이 장점입니다. 아래 보드에 자유롭게 작성해주세요.";

const emptyBoard = () => ({
  phase: "opinion",
  users: {},
  // 의견을 주제별로 나눠 받고 싶을 때를 위한 다중 보드 구조. 기본은 1개에서 시작하고 필요하면 늘린다
  topics: [{ id: uid(), title: "의견1" }],
  instructions: DEFAULT_INSTRUCTIONS,
  // 6번: "문제"는 별도 배열이 아니라 note.isProblem 플래그로 표현한다(데이터 복제 없음).
  notes: [],
  votesPerUser: 3,
  // 7번: 투표는 note.id 기준으로 집계한다. votes[noteId] = [이름, ...]
  votes: {},
  // ===== 회고/문서 확장 필드 =====
  // 회고 KPT: 참여자 이름을 키로 갖는다(users와 동일한 키잉). retros[이름] = { keep, problem, try, done }
  // done===true인 사람의 내용만 문서에 누적되고, done 후에도 자유롭게 수정 가능(실시간 반영).
  retros: {},
  // 회고 탭 상단 "우선순위 해결여부" 섹션 표시 여부 토글 (기본 ON)
  retroPriorityCheck: true,
  // 우선순위 문제별 해결여부. priorityResolution[noteId] = "resolved" | "partial" | "unresolved"
  // (votes/isProblem과 같은 "원본은 note 하나, 여기선 표시·기록만" 패턴)
  priorityResolution: {},
  // 문서 표준 필드(프로젝트당 1개). 과정/결과 문서 양쪽에 동일하게 반영된다.
  docFields: { purpose: "", background: "", direction: "", expected: "" },
  // 회의록 녹음(헤더의 "회의록 녹음")으로 누적한 전체 회의 녹취록. 문서에 "회의 녹취록" 섹션으로 포함된다.
  // (포스트잇 녹음과 별개의 버퍼. 녹음을 멈출 때 board에 저장돼 문서/다른 참여자에게도 반영된다.)
  minutes: "",
});

// 이전 버전에서 저장된 보드를 열어도 깨지지 않도록 보정한다.
// 특히 구버전의 별도 problems 배열을 note.isProblem + votes 재키잉으로 마이그레이션한다.
function normalizeBoard(raw) {
  const b = { ...emptyBoard(), ...raw };
  if (!b.topics || b.topics.length === 0) {
    b.topics = [{ id: uid(), title: "의견1" }];
  }
  if (!b.instructions) b.instructions = DEFAULT_INSTRUCTIONS;
  const firstTopicId = b.topics[0].id;
  b.notes = (b.notes || []).map((n) => ({ ...n, topicId: n.topicId || firstTopicId }));
  b.votes = b.votes || {};
  // 확장 필드 기본값 보정(구버전 보드 호환)
  b.retros = b.retros || {};
  b.retroPriorityCheck = b.retroPriorityCheck !== false; // 저장값 없으면 ON
  b.priorityResolution = b.priorityResolution || {};
  b.docFields = { purpose: "", background: "", direction: "", expected: "", ...(b.docFields || {}) };
  b.minutes = typeof b.minutes === "string" ? b.minutes : "";

  // ---- 구버전 problems 배열 마이그레이션 ----
  if (Array.isArray(b.problems)) {
    for (const p of b.problems) {
      if (p.sourceId) {
        // 의견에서 승격된 문제 -> 원본 노트에 isProblem 표시하고 표를 노트 id로 옮김
        const note = b.notes.find((n) => n.id === p.sourceId);
        if (note) {
          note.isProblem = true;
          if (b.votes[p.id] && !b.votes[note.id]) b.votes[note.id] = b.votes[p.id];
        }
      } else {
        // 직접 추가된 문제 -> 첫 보드에 문제 노트로 새로 만든다
        const nid = uid();
        b.notes.push({ id: nid, text: p.text || "", authors: p.authors || [], topicId: firstTopicId, isProblem: true });
        if (b.votes[p.id]) b.votes[nid] = b.votes[p.id];
      }
      // 노트 id로 옮겼으니 옛 problemId로 남은 표는 정리
      if (p.id && b.votes[p.id] && !b.notes.some((n) => n.id === p.id)) delete b.votes[p.id];
    }
    delete b.problems;
  }
  return b;
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// 안내 문구처럼 내용이 가변적인 textarea가 잘리거나 스크롤바가 생기지 않도록
// 내용 높이(scrollHeight)에 맞춰 실제 높이를 매번 다시 맞춰준다
function autoResizeTextarea(el) {
  if (!el) return;
  // "auto"는 rows 기본값(2줄)에 묶여, 한 줄짜리 내용도 2줄 높이를 유지한다.
  // 0으로 먼저 접은 뒤 scrollHeight를 재면 실제 내용 높이(짧으면 1줄, 길면 그만큼)에 정확히 맞는다.
  el.style.height = "0px";
  el.style.height = el.scrollHeight + "px";
}

// 가장 적게 쓰인 색상군 중에서 무작위 배정 -> 인원이 많아져도 특정 색으로 쏠리지 않게 함
function pickColor(users) {
  const used = Object.values(users).map((u) => u.color.name);
  const counts = PALETTE.map((c) => used.filter((n) => n === c.name).length);
  const min = Math.min(...counts);
  const candidates = PALETTE.filter((_, i) => counts[i] === min);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// ===== 4번: 과정+결과 문서화 (표 중심) =====
// 앱 내 문서 뷰와 다운로드가 같은 데이터를 쓰도록, 표에 필요한 값을 한 곳에서 계산한다.
function buildDocModel(project, board) {
  const participants = Object.entries(board.users).map(([name, u]) => ({ name, color: u.color }));
  const notesByTopic = board.topics.map((t) => ({
    title: t.title,
    notes: board.notes.filter((n) => n.topicId === t.id),
  }));
  const problemNotes = board.notes.filter((n) => n.isProblem);
  const ranked = problemNotes
    .map((n) => ({ ...n, votes: board.votes[n.id]?.length || 0, voters: board.votes[n.id] || [] }))
    .sort((a, b) => b.votes - a.votes);
  const topRanked = ranked.slice(0, 5);
  // 문서 표준 필드(프로젝트당 1개) — 과정/결과 문서 공통
  const docFields = board.docFields || {};
  // 완료(done)한 참여자의 KPT만 문서에 누적. users 키잉을 그대로 사용해 참여자 순서 유지.
  const completedRetros = participants
    .map((p) => ({ name: p.name, color: p.color, ...(board.retros?.[p.name] || {}) }))
    .filter((r) => r.done);
  // 회고 탭 토글이 ON일 때만 우선순위 해결여부를 문서에 포함(득표순 문제 + 해결여부)
  const priorityCheckOn = board.retroPriorityCheck !== false;
  const resolutionRows = priorityCheckOn
    ? ranked.map((n) => ({ id: n.id, text: n.text, votes: n.votes, resolution: board.priorityResolution?.[n.id] || "" }))
    : [];
  // 회의록 녹음(헤더)으로 누적한 전체 녹취록 — 있을 때만 "회의 녹취록" 섹션으로 문서에 포함
  const minutes = (board.minutes || "").trim();
  return { participants, notesByTopic, problemNotes, ranked, topRanked, docFields, completedRetros, priorityCheckOn, resolutionRows, minutes };
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// 다운로드용 자립형 HTML 문서 문자열 생성 (브라우저에서 바로 열람·인쇄 가능)
// docType: "process"(과정 전체) | "result"(우선순위 TOP 5 결과만)
function buildDocHtml(project, board, docType = "process") {
  const { participants, notesByTopic, problemNotes, ranked, topRanked, docFields, completedRetros, priorityCheckOn, resolutionRows, minutes } = buildDocModel(project, board);
  const dateStr = new Date().toLocaleString("ko-KR");
  const topVote = ranked[0];
  const nl2br = (s) => esc(s).replace(/\r?\n/g, "<br>");

  const style = `
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Malgun Gothic",sans-serif;color:#242424;max-width:860px;margin:0 auto;padding:40px 24px;line-height:1.6}
  h1{font-size:26px;margin:0 0 4px}
  .sub{color:#888;font-size:13px;margin-bottom:32px}
  h2{font-size:18px;margin:36px 0 12px;padding-bottom:6px;border-bottom:2px solid #eee}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{border:1px solid #e0e0e0;padding:9px 12px;text-align:left;vertical-align:top}
  thead th{background:#e9e9e9;font-weight:700}
  tbody th{background:#f2f2f2;width:160px;white-space:nowrap}
  .chip{display:inline-block;border-radius:6px;padding:2px 10px;font-size:12px;font-weight:600}
  .empty{color:#aaa}
  .rank1 td{background:#fdf3f7}
  .desc{color:#777;font-size:12.5px;margin-top:3px}
  .retro-name{background:#f2f2f2;font-weight:700}
  footer{margin-top:40px;color:#aaa;font-size:12px;text-align:center}`;

  // 문서 표준 필드(목적/배경/추진 방향/기대 효과) — 과정/결과 문서 공통, 항상 최상단
  const fieldsSection = `<h2>문서 표준 정보</h2>
<table><tbody>${[
    ["목적", docFields.purpose],
    ["배경", docFields.background],
    ["추진 방향", docFields.direction],
    ["기대 효과", docFields.expected],
  ]
    .map(([k, v]) => `<tr><th>${k}</th><td>${v && v.trim() ? nl2br(v) : '<span class="empty">—</span>'}</td></tr>`)
    .join("")}</tbody></table>`;

  // 우선순위 해결여부 (회고 토글 ON일 때만)
  const resolutionSection = priorityCheckOn
    ? `<h2>우선순위 해결여부</h2>
<table><thead><tr><th>#</th><th>문제</th><th>득표</th><th>해결여부</th></tr></thead><tbody>${
        resolutionRows.length
          ? resolutionRows
              .map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.text)}</td><td>${r.votes}표</td><td>${RESOLUTION_LABELS[r.resolution] || '<span class="empty">미정</span>'}</td></tr>`)
              .join("")
          : `<tr><td colspan="4" class="empty">우선순위로 정리된 문제가 없습니다.</td></tr>`
      }</tbody></table>`
    : "";

  // 회고(KPT) — 완료한 참여자만
  const retroSection = `<h2>회고 (KPT)</h2>${
    completedRetros.length
      ? completedRetros
          .map(
            (r) =>
              `<table style="margin-bottom:16px"><tbody><tr><th class="retro-name" colspan="2">${esc(r.name)}</th></tr><tr><th>Keep</th><td>${r.keep && r.keep.trim() ? nl2br(r.keep) : '<span class="empty">—</span>'}</td></tr><tr><th>Problem</th><td>${r.problem && r.problem.trim() ? nl2br(r.problem) : '<span class="empty">—</span>'}</td></tr><tr><th>Try</th><td>${r.try && r.try.trim() ? nl2br(r.try) : '<span class="empty">—</span>'}</td></tr></tbody></table>`
          )
          .join("")
      : `<p class="empty">완료된 회고가 없습니다.</p>`
  }`;

  // 회의 녹취록 — 회의록 녹음 내용이 있을 때만
  const minutesSection = minutes
    ? `<h2>회의 녹취록</h2>
<table><tbody><tr><td style="white-space:pre-wrap;line-height:1.7">${nl2br(minutes)}</td></tr></tbody></table>`
    : "";

  if (docType === "result") {
    const overviewRows = [
      ["프로젝트명", esc(project.title)],
      ["문서 생성일시", esc(dateStr)],
      ["문제로 표시된 의견 수", `${problemNotes.length}개`],
      ["최다 득표", topVote ? `${esc(topVote.text)} (${topVote.votes}표)` : "—"],
    ]
      .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
      .join("");

    const topRows = topRanked.length
      ? topRanked
          .map(
            (p, i) =>
              `<tr${i === 0 ? ' class="rank1"' : ""}><td>${i + 1}</td><td>${esc(p.text)}${p.description ? `<div class="desc">설명: ${esc(p.description)}</div>` : ""}</td><td>${p.votes}표</td><td>${esc(p.voters.join(", ")) || "—"}</td></tr>`
          )
          .join("")
      : `<tr><td colspan="4" class="empty">결과가 없습니다.</td></tr>`;

    return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${esc(project.title)} — 결과 문서</title>
<style>${style}</style></head><body>
<h1>${esc(project.title)}</h1>
<div class="sub">Onalign 퍼실리테이션 결과 문서 · ${esc(dateStr)}</div>

${fieldsSection}

<h2>개요</h2>
<table><tbody>${overviewRows}</tbody></table>

<h2>우선순위 TOP 5 결과</h2>
<table><thead><tr><th>순위</th><th>문제</th><th>득표</th><th>투표자</th></tr></thead><tbody>${topRows}</tbody></table>

${resolutionSection}

${retroSection}

${minutesSection}

<footer>Generated by Onalign</footer>
</body></html>`;
  }

  // docType === "process": 과정 전체 (개요·참여자·의견 모음·문제 정리)
  const overviewRows = [
    ["프로젝트명", esc(project.title)],
    ["문서 생성일시", esc(dateStr)],
    ["참여자 수", `${participants.length}명`],
    ["작성된 의견 수", `${board.notes.length}개`],
    ["문제로 표시된 의견 수", `${problemNotes.length}개`],
  ]
    .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
    .join("");

  const participantRows = participants.length
    ? participants
        .map(
          (p) =>
            `<tr><td>${esc(p.name)}</td><td><span class="chip" style="background:${p.color.bg};color:${p.color.text};border:1px solid ${p.color.border}">${p.color.name}</span></td></tr>`
        )
        .join("")
    : `<tr><td colspan="2" class="empty">참여자가 없습니다.</td></tr>`;

  const opinionRows = board.notes.length
    ? notesByTopic
        .flatMap((t) =>
          t.notes.map(
            (n) =>
              `<tr><td>${esc(t.title)}</td><td>${esc(n.text) || '<span class="empty">(빈 포스트잇)</span>'}${n.isProblem ? ' <span class="chip" style="background:#fdecec;color:#c0392b;border:1px solid #eab5b0">문제</span>' : ""}</td><td>${esc(n.authors.join(", "))}</td></tr>`
          )
        )
        .join("")
    : `<tr><td colspan="3" class="empty">작성된 의견이 없습니다.</td></tr>`;

  const problemRows = problemNotes.length
    ? problemNotes
        .map(
          (n, i) =>
            `<tr><td>${i + 1}</td><td>${esc(n.text)}${n.description ? `<div class="desc">설명: ${esc(n.description)}</div>` : ""}</td><td>${esc(n.authors.join(", "))}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="3" class="empty">문제로 표시된 의견이 없습니다.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${esc(project.title)} — 과정 문서</title>
<style>${style}</style></head><body>
<h1>${esc(project.title)}</h1>
<div class="sub">Onalign 퍼실리테이션 과정 문서 · ${esc(dateStr)}</div>

${fieldsSection}

<h2>개요</h2>
<table><tbody>${overviewRows}</tbody></table>

<h2>참여자</h2>
<table><thead><tr><th>이름</th><th>배정 색상</th></tr></thead><tbody>${participantRows}</tbody></table>

<h2>의견 모음 (과정)</h2>
<table><thead><tr><th>주제</th><th>내용</th><th>작성자</th></tr></thead><tbody>${opinionRows}</tbody></table>

<h2>문제 정리 및 부가 설명</h2>
<table><thead><tr><th>#</th><th>문제</th><th>작성자</th></tr></thead><tbody>${problemRows}</tbody></table>

${resolutionSection}

${retroSection}

${minutesSection}

<footer>Generated by Onalign</footer>
</body></html>`;
}

function mdEsc(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

// 다운로드용 마크다운 문서 문자열 생성 (노션·구글독스 등에 붙여넣기 좋은 표 형식)
function buildDocMarkdown(project, board, docType = "process") {
  const { participants, notesByTopic, problemNotes, ranked, topRanked, docFields, completedRetros, priorityCheckOn, resolutionRows, minutes } = buildDocModel(project, board);
  const dateStr = new Date().toLocaleString("ko-KR");
  const topVote = ranked[0];

  // 회의 녹취록 — 회의록 녹음 내용이 있을 때만 (표가 아닌 본문이라 줄바꿈만 유지)
  const minutesSection = minutes ? `## 회의 녹취록\n\n${minutes.replace(/\r?\n/g, "  \n")}` : "";

  // 문서 표준 정보(목적/배경/추진 방향/기대 효과) — 과정/결과 공통, 항상 최상단
  const fieldsSection = `## 문서 표준 정보

| 항목 | 내용 |
| --- | --- |
${[
    ["목적", docFields.purpose],
    ["배경", docFields.background],
    ["추진 방향", docFields.direction],
    ["기대 효과", docFields.expected],
  ]
    .map(([k, v]) => `| ${mdEsc(k)} | ${v && v.trim() ? mdEsc(v) : "—"} |`)
    .join("\n")}`;

  // 우선순위 해결여부 (회고 토글 ON일 때만)
  const resolutionSection = priorityCheckOn
    ? `## 우선순위 해결여부

| # | 문제 | 득표 | 해결여부 |
| --- | --- | --- | --- |
${
        resolutionRows.length
          ? resolutionRows.map((r, i) => `| ${i + 1} | ${mdEsc(r.text)} | ${r.votes}표 | ${RESOLUTION_LABELS[r.resolution] || "미정"} |`).join("\n")
          : "| - | 우선순위로 정리된 문제가 없습니다. | - | - |"
      }`
    : "";

  // 회고(KPT) — 완료한 참여자만
  const retroSection = `## 회고 (KPT)

${
    completedRetros.length
      ? completedRetros
          .map(
            (r) =>
              `### ${r.name}\n\n| 구분 | 내용 |\n| --- | --- |\n| Keep | ${r.keep && r.keep.trim() ? mdEsc(r.keep) : "—"} |\n| Problem | ${r.problem && r.problem.trim() ? mdEsc(r.problem) : "—"} |\n| Try | ${r.try && r.try.trim() ? mdEsc(r.try) : "—"} |`
          )
          .join("\n\n")
      : "완료된 회고가 없습니다."
  }`;

  if (docType === "result") {
    const overviewRows = [
      ["프로젝트명", project.title],
      ["문서 생성일시", dateStr],
      ["문제로 표시된 의견 수", `${problemNotes.length}개`],
      ["최다 득표", topVote ? `${topVote.text} (${topVote.votes}표)` : "—"],
    ]
      .map(([k, v]) => `| ${mdEsc(k)} | ${mdEsc(v)} |`)
      .join("\n");

    const topRows = topRanked.length
      ? topRanked
          .map((p, i) => {
            const text = p.description ? `${p.text} (설명: ${p.description})` : p.text;
            return `| ${i + 1} | ${mdEsc(text)} | ${p.votes}표 | ${mdEsc(p.voters.join(", ")) || "—"} |`;
          })
          .join("\n")
      : `| - | 결과가 없습니다. | - | - |`;

    return `# ${project.title}

Onalign 퍼실리테이션 결과 문서 · ${dateStr}

${fieldsSection}

## 개요

| 항목 | 내용 |
| --- | --- |
${overviewRows}

## 우선순위 TOP 5 결과

| 순위 | 문제 | 득표 | 투표자 |
| --- | --- | --- | --- |
${topRows}

${resolutionSection}

${retroSection}

${minutesSection}

---
Generated by Onalign
`;
  }

  // docType === "process": 과정 전체 (개요·참여자·의견 모음·문제 정리)
  const overviewRows = [
    ["프로젝트명", project.title],
    ["문서 생성일시", dateStr],
    ["참여자 수", `${participants.length}명`],
    ["작성된 의견 수", `${board.notes.length}개`],
    ["문제로 표시된 의견 수", `${problemNotes.length}개`],
  ]
    .map(([k, v]) => `| ${mdEsc(k)} | ${mdEsc(v)} |`)
    .join("\n");

  const participantRows = participants.length
    ? participants.map((p) => `| ${mdEsc(p.name)} | ${p.color.name} |`).join("\n")
    : `| - | 참여자가 없습니다. |`;

  const opinionRows = board.notes.length
    ? notesByTopic
        .flatMap((t) =>
          t.notes.map((n) => {
            const text = (n.text || "(빈 포스트잇)") + (n.isProblem ? " `문제`" : "");
            return `| ${mdEsc(t.title)} | ${mdEsc(text)} | ${mdEsc(n.authors.join(", "))} |`;
          })
        )
        .join("\n")
    : `| - | 작성된 의견이 없습니다. | - |`;

  const problemRows = problemNotes.length
    ? problemNotes
        .map((n, i) => {
          const text = n.description ? `${n.text} (설명: ${n.description})` : n.text;
          return `| ${i + 1} | ${mdEsc(text)} | ${mdEsc(n.authors.join(", "))} |`;
        })
        .join("\n")
    : `| - | 문제로 표시된 의견이 없습니다. | - |`;

  return `# ${project.title}

Onalign 퍼실리테이션 과정 문서 · ${dateStr}

${fieldsSection}

## 개요

| 항목 | 내용 |
| --- | --- |
${overviewRows}

## 참여자

| 이름 | 배정 색상 |
| --- | --- |
${participantRows}

## 의견 모음 (과정)

| 주제 | 내용 | 작성자 |
| --- | --- | --- |
${opinionRows}

## 문제 정리 및 부가 설명

| # | 문제 | 작성자 |
| --- | --- | --- |
${problemRows}

${resolutionSection}

${retroSection}

${minutesSection}

---
Generated by Onalign
`;
}

// ===== 2번 관련: 작업 흐름 안내 투어 (세션당 1회) =====
const GUIDE_SESSION_KEY = "onalign-guide-done";

// 프로젝트/이름 화면은 제외. 작업 흐름만 순서대로 연이어 안내한다.
const TOUR_STEPS = [
  { target: "add-note", screen: "opinion", text: "포스트잇을 만들고 자유롭게 적어보세요" },
  { target: "merge", screen: "opinion", text: "비슷한 의견은 합쳐보세요" },
  { target: "note-board", screen: "opinion", text: "중요한 의견은 '문제로' 표시하세요" },
  { target: "vote-status", screen: "opinion", text: "문제로 표시된 의견에 투표하세요" },
  { target: "problem-area", screen: "problem", text: "문제 문구를 여기서 다듬으세요" },
  { target: "vote-area", screen: "voting", text: "득표순 결과를 확인하세요" },
  { target: "retro-priority", screen: "retro", text: "회고 단계예요. 우선순위로 정한 문제들이 이번에 해결됐는지 여기서 함께 점검하세요 (필요 없으면 토글을 꺼도 됩니다)" },
  { target: "retro-kpt", screen: "retro", text: "각자 Keep·Problem·Try를 적고 '완료'를 누르세요. 완료한 사람의 회고가 문서에 자동으로 담기고, 완료 후에도 수정하면 문서에 바로 반영돼요" },
  { target: "doc-type-process", screen: "document", text: "과정 문서에는 표준 정보(목적·배경·추진 방향·기대 효과)와 의견·문제 정리, 완료된 회고까지 한 흐름으로 정리돼요" },
  { target: "doc-type-result", screen: "document", text: "결과 문서에는 우선순위 TOP 5와 해결여부, 완료된 회고가 간추려 담겨요" },
  { target: "doc-download", screen: "document", text: "완성된 문서를 이미지·HTML·마크다운으로 저장해 팀과 공유하세요" },
];

function guideDoneThisSession() {
  try {
    return !!sessionStorage.getItem(GUIDE_SESSION_KEY);
  } catch (e) {
    return false;
  }
}

function GuideCoach({ phase, onGotoScreen }) {
  // 세션당 1회: 이번 세션에 이미 봤으면 -1(비활성)로 시작
  const [step, setStep] = useState(() => (guideDoneThisSession() ? -1 : 0));
  const [rect, setRect] = useState(null);
  // 말풍선 실측 크기(화면이 좁아 텍스트가 더 꺾이면 높이가 달라짐) - 화면 밖으로 나가지 않도록 클램프할 때 사용
  const bubbleRef = useRef(null);
  const [bubbleSize, setBubbleSize] = useState({ width: 250, height: 120 });

  const active = step >= 0 && step < TOUR_STEPS.length ? TOUR_STEPS[step] : null;

  // 현재 단계 화면과 보드 화면이 다르면 해당 탭으로 자동 전환 -> 흐름대로 연이어 안내
  useEffect(() => {
    if (active && active.screen !== phase) onGotoScreen(active.screen);
  }, [active, phase, onGotoScreen]);

  // 새 단계로 넘어가면 대상 요소가 화면 밖(스크롤 아래/위)에 있어도 항상 보이도록 화면 중앙으로 스크롤한다.
  // 이게 없으면 대상이 접힌 화면 밖에 있을 때 하이라이트/말풍선이 화면 밖에 그려져 "위치가 안 맞고 안 보이는" 문제가 생긴다.
  // (헤더에 고정된 대상처럼 이미 다 보이는 요소는 스크롤하지 않는다)
  useEffect(() => {
    if (!active || active.screen !== phase) return;
    // 화면 전환/재렌더 직후 요소가 DOM에 잡히도록 약간 지연
    const t = setTimeout(() => {
      const el = document.querySelector(`[data-guide="${active.target}"]`);
      if (!el) return;
      const r = el.getBoundingClientRect();
      // 헤더에 고정된 대상(save-image)은 위쪽에 있어도 정상이므로 헤더 높이만큼의 여백을 요구하지 않는다.
      const topClear = active.target === "save-image" ? 0 : 66;
      const fullyVisible = r.top >= topClear && r.bottom <= window.innerHeight - 12;
      if (!fullyVisible) el.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 80);
    return () => clearTimeout(t);
  }, [step, active, phase]);

  // 대상 요소 위치 추적 (스크롤·레이아웃 변동·늦은 렌더 대응). 변화가 있을 때만 상태 갱신.
  useEffect(() => {
    if (!active || active.screen !== phase) {
      setRect(null);
      return;
    }
    const target = active.target;
    const update = () => {
      const el = document.querySelector(`[data-guide="${target}"]`);
      if (!el) {
        setRect(null);
        return;
      }
      const r = el.getBoundingClientRect();
      setRect((prev) =>
        prev && prev.top === r.top && prev.left === r.left && prev.width === r.width && prev.height === r.height
          ? prev
          : { top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.bottom }
      );
    };
    update();
    const iv = setInterval(update, 100);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      clearInterval(iv);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [active, phase]);

  // 말풍선 실제 렌더 크기를 측정해둔다 (창 크기가 좁아지면 폭이 줄고 줄바꿈으로 높이가 늘어남 -> 화면 밖으로 못 나가게 이 값으로 위치를 클램프한다)
  useEffect(() => {
    const measure = () => {
      if (bubbleRef.current) {
        const r = bubbleRef.current.getBoundingClientRect();
        setBubbleSize({ width: r.width, height: r.height });
      }
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [step, rect]);

  const endTour = () => {
    try {
      sessionStorage.setItem(GUIDE_SESSION_KEY, "1");
    } catch (e) {
      /* noop */
    }
    setStep(-1);
    onGotoScreen("opinion"); // 안내가 끝나면 작업 시작 지점으로 되돌림
  };

  const next = () => {
    if (step >= TOUR_STEPS.length - 1) {
      endTour();
      return;
    }
    setStep(step + 1);
  };

  // 현재 화면이 아니거나 아직 단계가 없으면 아무것도 그리지 않는다.
  // rect가 없어도(대상 요소가 화면에 없어도) 안내는 계속돼야 하므로 여기서 끝내지 않는다.
  if (!active || active.screen !== phase) return null;

  // 화면이 좁아져도 말풍선이 밖으로 나가지 않도록: 폭은 뷰포트에 맞춰 줄이고,
  // 위치는 실측 크기(bubbleSize) 기준으로 좌우/상하 여백 안쪽으로 클램프한다.
  const margin = 12;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  const bubbleWidth = Math.min(250, viewportW - margin * 2);
  const bubbleHeight = bubbleSize.height || 120;

  // 대상 요소가 없을 때(예: 온보딩 중 비어 있는 "문제 정리" 탭)는 하이라이트 없이
  // 화면 중앙에 안내만 띄워 투어 흐름이 끊기지 않게 한다.
  const hasRect = !!rect;
  let left, top, below, arrowLeft;
  if (hasRect) {
    const idealLeft = rect.left + rect.width / 2 - bubbleWidth / 2;
    left = Math.min(Math.max(idealLeft, margin), Math.max(margin, viewportW - bubbleWidth - margin));
    const spaceBelow = viewportH - rect.bottom;
    const spaceAbove = rect.top;
    below = spaceBelow >= bubbleHeight + 24 || spaceBelow >= spaceAbove;
    top = below
      ? Math.min(rect.bottom + 14, viewportH - bubbleHeight - margin)
      : Math.max(rect.top - 14 - bubbleHeight, margin);
    // 화살표는 말풍선이 가장자리에 밀려도 실제 대상 쪽을 가리키도록 상대 위치로 계산
    arrowLeft = Math.min(Math.max(rect.left + rect.width / 2 - left, 16), bubbleWidth - 16);
  } else {
    left = Math.max(margin, (viewportW - bubbleWidth) / 2);
    top = Math.max(margin, (viewportH - bubbleHeight) / 2);
    below = true;
    arrowLeft = -100; // 대상이 없으면 화살표는 숨긴다
  }
  const isLast = step === TOUR_STEPS.length - 1;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9998, pointerEvents: "auto", background: "rgba(20,20,20,0.32)", fontFamily: "sans-serif" }}>
      {/* 가이드가 떠있는 동안은 뒤 화면 조작을 완전히 막는 모달형 오버레이.
          "다음/건너뛰기"를 누르기 전까지 다른 작업(포스트잇 추가 등)이 가능하면 가이드가 거슬리기만 하고
          안 읽고 넘어가는 문제가 있어, 가이드를 다 보거나 건너뛰어야만 다음 작업이 가능하도록 강제한다. */}
      <style>{`@keyframes onalignPulse{0%{box-shadow:0 0 0 0 rgba(114,201,172,.55)}70%{box-shadow:0 0 0 8px rgba(114,201,172,0)}100%{box-shadow:0 0 0 0 rgba(114,201,172,0)}}`}</style>

      {hasRect && active.target !== "vote-area" && (
        <div
          style={{
            position: "absolute",
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12,
            border: "2px solid #72c9ac",
            borderRadius: 12,
            boxSizing: "border-box",
            animation: "onalignPulse 1.8s infinite",
          }}
        />
      )}

      <motion.div
        key={step}
        ref={bubbleRef}
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.2, ease: EASE }}
        style={{
          position: "absolute",
          left,
          top,
          width: bubbleWidth,
          maxWidth: `calc(100vw - ${margin * 2}px)`,
          background: "#242424",
          color: "#f2f2f2",
          borderRadius: 12,
          padding: "14px 16px",
          boxShadow: "0 10px 32px rgba(0,0,0,.3)",
          pointerEvents: "auto",
          boxSizing: "border-box",
        }}
      >
        {hasRect && (
          <div
            style={{
              position: "absolute",
              left: arrowLeft - 6,
              transform: "rotate(45deg)",
              width: 12,
              height: 12,
              background: "#242424",
              ...(below ? { top: -6 } : { bottom: -6 }),
            }}
          />
        )}
        <div style={{ fontSize: 11, color: "#8a8a8a", marginBottom: 6, position: "relative" }}>
          가이드 {step + 1} / {TOUR_STEPS.length}
        </div>
        <div style={{ fontSize: 14, lineHeight: 1.5, marginBottom: 12, position: "relative" }}>{active.text}</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, position: "relative" }}>
          <button
            onClick={endTour}
            style={{ border: "none", background: "none", color: "#8a8a8a", fontSize: 12, cursor: "pointer", padding: 0 }}
          >
            건너뛰기
          </button>
          <button
            onClick={next}
            style={{ border: "none", background: "#f2f2f2", color: "#242424", borderRadius: 8, padding: "6px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
          >
            {isLast ? "시작하기" : "다음"}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// 1번: 모든 화면 최상단에 고정되는 로고 영역. 로고는 랜딩 페이지(첫 화면)로,
// "내 프로젝트"는 앱 내 프로젝트 목록 화면으로 이동한다. right에 화면별 우측 콘텐츠(프로필 등)를 넣는다.
// onSaveImage가 주어지면(보드 화면에서만) "내 프로젝트" 옆에 "이미지로 저장"을 같은 텍스트 스타일로 붙인다.
function TopBar({ onProjects, onSaveImage, onMinutes, minutesRecording, right }) {
  const goHome = () => {
    window.location.href = "/";
  };
  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 100,
        background: "#fff",
        borderBottom: "1px solid rgba(36,35,34,.09)",
      }}
    >
      <div
        style={{
          maxWidth: 1120,
          margin: "0 auto",
          padding: "13px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <Logo onClick={goHome} height={34} />
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <button
            onClick={onProjects}
            style={{ border: "none", background: "none", color: "#6f6b66", fontSize: 15, fontWeight: 600, cursor: "pointer", padding: 0 }}
          >
            내 프로젝트
          </button>
          {onSaveImage && (
            <button
              data-guide="save-image"
              onClick={onSaveImage}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: "#fff",
                border: "1px solid rgba(36,35,34,.14)",
                borderRadius: 9,
                padding: "8px 13px",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                color: "#242322",
                whiteSpace: "nowrap",
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              전체 화면 이미지로 저장
            </button>
          )}
          {onMinutes && (
            <button
              onClick={onMinutes}
              title="전체 회의를 녹음해 회의록으로 만듭니다"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: minutesRecording ? "#fdeaea" : "#fff",
                border: `1px solid ${minutesRecording ? "#ffcaca" : "rgba(36,35,34,.14)"}`,
                borderRadius: 9,
                padding: "8px 13px",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                color: minutesRecording ? "#d32f2f" : "#242322",
                whiteSpace: "nowrap",
              }}
            >
              <span style={{ width: 9, height: 9, borderRadius: 999, background: "#ff4242", animation: minutesRecording ? "oaRecPulse 1.1s ease-in-out infinite" : "none" }} />
              {minutesRecording ? "회의록 녹음 중" : "회의록 녹음"}
            </button>
          )}
          {right}
        </div>
      </div>
    </header>
  );
}

export default function FacilitationBoard() {
  const [projects, setProjects] = useState(null);
  const [selectedProject, setSelectedProject] = useState(null);
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [newProjectGoal, setNewProjectGoal] = useState(""); // 프로젝트 목표 한 줄(선택 입력)
  const [name, setName] = useState(null);
  const [nameInput, setNameInput] = useState("");
  const [board, setBoard] = useState(emptyBoard());
  const [loaded, setLoaded] = useState(false);
  const [justCreatedId, setJustCreatedId] = useState(null);
  const [mergeMode, setMergeMode] = useState(false);
  const [selected, setSelected] = useState([]);
  const [confirmState, setConfirmState] = useState(null); // { title, message, confirmLabel, onConfirm }
  const [docType, setDocType] = useState("process"); // "문서" 탭에서 선택한 문서 종류: 과정 | 결과(TOP 5)
  const [parkingOpen, setParkingOpen] = useState(false); // 보류함 접이식 섹션 열림 여부 (기본 닫힘)
  // ===== 음성 녹음 → 텍스트 변환 (Web Speech API, 마이크 입력 기준) =====
  // recording 상태(board.recording)는 참여자 모두에게 보이는 공유 배지지만, 실제 음성 인식은
  // "녹음 버튼을 누른 이 브라우저"에서만 로컬로 돌아간다. 인식 결과도 이 브라우저에 로컬로 쌓인다.
  // 회의록 녹음(헤더): 마이크 음성을 Web Speech API로 실시간 텍스트화해 전체 회의 녹취록을 누적한다.
  // .txt 다운로드 + 문서 탭 "회의 녹취록" 섹션에 반영된다. (마이크가 하나라 녹음은 이 한 종류만 둔다.)
  const [micRecording, setMicRecording] = useState(false); // 이 브라우저에서 실제 인식이 돌고 있는지
  const [minutes, setMinutes] = useState(""); // 확정된 회의 녹취록(누적)
  const [minutesInterim, setMinutesInterim] = useState(""); // 인식 중인 임시 텍스트(아직 확정 전)
  const [minutesOpen, setMinutesOpen] = useState(false); // 회의록 패널 열림 여부
  const minutesRef = useRef(""); // onresult 콜백에서 최신 녹취록을 참조하기 위한 ref
  const [speechSupported, setSpeechSupported] = useState(true); // 브라우저가 Web Speech API를 지원하는지
  const recognitionRef = useRef(null); // SpeechRecognition 인스턴스
  const wantRecordingRef = useRef(false); // 사용자가 "녹음 중"을 의도하는지 (자동 재시작 판단용)
  const boardRef = useRef(board);
  boardRef.current = board;
  // 드래그 중이거나 포스트잇을 편집 중일 때는 2초 폴링이 로컬 변경을 덮어쓰지 않도록 잠시 멈춘다
  const suspendPollRef = useRef(false);
  // 보류함 항목 클릭 시 원래 의견 보드로 스크롤 이동하기 위한 topic별 DOM 참조
  const topicRefs = useRef({});
  // "이미지로 저장": 현재 탭에 실제로 렌더링된 화면 전체를 그대로 캡처하기 위한 DOM 참조
  const phaseContentRef = useRef(null);
  // 문서 탭 전용 "이미지로 저장": 다운로드 버튼 등 UI를 빼고 문서 내용(표)만 캡처하기 위한 DOM 참조
  const docContentRef = useRef(null);

  // 프로젝트 인덱스 로드 (목록 화면에서 항상 최신 상태 유지)
  const loadProjects = useCallback(async () => {
    try {
      const res = await storage.get(PROJECTS_INDEX_KEY, true);
      setProjects(res && res.value ? JSON.parse(res.value) : []);
    } catch (e) {
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const createProject = async () => {
    const title = newProjectTitle.trim();
    if (!title) return;
    const project = { id: uid(), title, goal: newProjectGoal.trim(), createdAt: Date.now() };
    const nextList = [project, ...(projects || [])];
    await storage.set(PROJECTS_INDEX_KEY, JSON.stringify(nextList), true);
    await storage.set(boardKeyOf(project.id), JSON.stringify(emptyBoard()), true);
    setProjects(nextList);
    setNewProjectTitle("");
    setNewProjectGoal("");
    setSelectedProject(project);
  };

  // 프로젝트 목표 한 줄 수정. 프로젝트 메타데이터(PROJECTS_INDEX_KEY)에 저장되므로
  // 목록과 현재 selectedProject 스냅샷을 함께 갱신해야 화면에 바로 반영된다.
  const updateProjectGoal = async (goalText) => {
    if (!selectedProject) return;
    const goal = goalText.trim();
    const nextList = (projects || []).map((p) => (p.id === selectedProject.id ? { ...p, goal } : p));
    await storage.set(PROJECTS_INDEX_KEY, JSON.stringify(nextList), true);
    setProjects(nextList);
    setSelectedProject((prev) => (prev ? { ...prev, goal } : prev));
  };

  // 프로젝트 고정. 고정된 프로젝트는 목록 정렬 시 항상 위로 온다 (updateProjectGoal과 동일한 패턴으로 인덱스만 갱신)
  const togglePinProject = async (id) => {
    const nextList = (projects || []).map((p) => (p.id === id ? { ...p, pinned: !p.pinned } : p));
    await storage.set(PROJECTS_INDEX_KEY, JSON.stringify(nextList), true);
    setProjects(nextList);
  };

  const deleteProject = async (id) => {
    const nextList = (projects || []).filter((p) => p.id !== id);
    await storage.set(PROJECTS_INDEX_KEY, JSON.stringify(nextList), true);
    await storage.delete(boardKeyOf(id), true).catch(() => {});
    clearSavedName(id);
    setProjects(nextList);
  };

  const backToProjects = () => {
    setSelectedProject(null);
    setName(null);
    setLoaded(false);
    setMergeMode(false);
    setSelected([]);
    setBoard(emptyBoard());
  };

  // 저장소에서 현재 프로젝트의 보드 상태를 읽어옴
  const loadBoard = useCallback(async () => {
    if (!selectedProject) return;
    try {
      const res = await storage.get(boardKeyOf(selectedProject.id), true);
      if (res && res.value) {
        setBoard(normalizeBoard(JSON.parse(res.value)));
      }
    } catch (e) {
      // key not created yet
    }
    setLoaded(true);
  }, [selectedProject]);

  // 보드 상태를 통째로 저장. 여러 하위 키로 쪼개면 동시 수정 시 last-write-wins로 유실될 위험이 커서
  // 하나의 키 안에서 전체 객체를 갱신하는 방식을 쓴다
  const saveBoard = useCallback(
    async (next) => {
      if (!selectedProject) return;
      setBoard(next);
      try {
        await storage.set(boardKeyOf(selectedProject.id), JSON.stringify(next), true);
      } catch (e) {
        console.error("저장 실패", e);
      }
    },
    [selectedProject]
  );

  useEffect(() => {
    if (!selectedProject) return;
    loadBoard();
    // 2초 간격 폴링으로 다른 참여자의 변경사항을 반영 (websocket 없이 유사 실시간 구현)
    // 단, 드래그나 텍스트 편집 중에는 건드리지 않는다 -> 안 그러면 끌던 포스트잇이 튀거나 타이핑 중 내용이 사라짐
    const iv = setInterval(() => {
      if (!suspendPollRef.current) loadBoard();
    }, 2000);
    return () => clearInterval(iv);
  }, [selectedProject, loadBoard]);

  // 이름으로 참여(등록). joinBoard(수동 입력)과 자동 재진입이 함께 쓴다.
  const doJoin = useCallback(
    async (rawName) => {
      const trimmed = (rawName || "").trim();
      if (!trimmed || !selectedProject) return;
      await loadBoard();
      const current = boardRef.current;
      const color = current.users[trimmed] ? current.users[trimmed].color : pickColor(current.users);
      await saveBoard({ ...current, users: { ...current.users, [trimmed]: { color } } });
      setSavedName(selectedProject.id, trimmed); // 2번: 이 브라우저·이 프로젝트에 내 이름 기억
      setName(trimmed);
    },
    [selectedProject, loadBoard, saveBoard]
  );

  const joinBoard = () => doJoin(nameInput);

  // 2번: 같은 브라우저에서 참여한 적 있는 프로젝트면 이름 화면을 건너뛰고 바로 입장
  useEffect(() => {
    if (selectedProject && !name) {
      const saved = getSavedName(selectedProject.id);
      if (saved) doJoin(saved);
    }
    // name을 의존성에 넣지 않는다: 자동 입장 후 재실행/루프 방지
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProject]);

  // 2번: 다른 이름으로 다시 참여하고 싶을 때 -> 기억된 이름을 지우고 이름 화면으로
  const changeName = () => {
    if (selectedProject) clearSavedName(selectedProject.id);
    setName(null);
    setNameInput("");
    setMergeMode(false);
    setSelected([]);
  };

  const myColor = name && board.users[name] ? board.users[name].color : PALETTE[0];

  // 새 포스트잇을 지정된 의견 보드(topic) 맨 아래에 추가한다. 배열의 뒤쪽에 붙이는 것만으로
  // "추가하면 하단에 생기는" 순서가 자연스럽게 보장된다 (별도 좌표 계산이 필요 없음)
  const createBlankNote = async (topicId) => {
    if (!name) return;
    await loadBoard();
    const current = boardRef.current;
    const note = { id: uid(), text: "", authors: [name], topicId, isProblem: false, isParked: false };
    await saveBoard({ ...current, notes: [...current.notes, note] });
    setJustCreatedId(note.id);
  };

  // 새 의견 보드(주제) 추가
  const addTopic = async () => {
    await loadBoard();
    const current = boardRef.current;
    const topic = { id: uid(), title: `의견${current.topics.length + 1}` };
    await saveBoard({ ...current, topics: [...current.topics, topic] });
  };

  const renameTopic = async (id, title) => {
    await loadBoard();
    const current = boardRef.current;
    await saveBoard({ ...current, topics: current.topics.map((t) => (t.id === id ? { ...t, title } : t)) });
  };

  // 3번: 의견 보드 삭제. 빈 보드는 바로 삭제, 포스트잇이 있으면 확인 팝업을 거친다.
  const deleteTopic = async (topicId) => {
    await loadBoard();
    const current = boardRef.current;
    const removedIds = current.notes.filter((n) => n.topicId === topicId).map((n) => n.id);
    const votes = { ...current.votes };
    removedIds.forEach((id) => delete votes[id]);
    await saveBoard({
      ...current,
      topics: current.topics.filter((t) => t.id !== topicId),
      notes: current.notes.filter((n) => n.topicId !== topicId),
      votes,
    });
  };

  const requestDeleteTopic = (topic) => {
    const hasNotes = board.notes.some((n) => n.topicId === topic.id);
    if (!hasNotes) {
      deleteTopic(topic.id);
      return;
    }
    setConfirmState({
      title: "의견 보드 삭제",
      message: "의견이 아직 남아있습니다. 삭제하시겠습니까?",
      confirmLabel: "삭제",
      onConfirm: () => {
        deleteTopic(topic.id);
        setConfirmState(null);
      },
    });
  };

  const updateInstructions = async (text) => {
    await loadBoard();
    const current = boardRef.current;
    await saveBoard({ ...current, instructions: text });
  };

  // ===== 회고(KPT) 핸들러 =====
  // 본인 칸 텍스트를 타이핑하는 동안은 로컬만 갱신(폴링이 지우지 않도록). 포스트잇 편집과 동일한 패턴.
  const editRetroLocal = (owner, field, value) => {
    setBoard((prev) => ({
      ...prev,
      retros: { ...prev.retros, [owner]: { ...(prev.retros?.[owner] || {}), [field]: value } },
    }));
  };
  // blur 시 최신 원격 상태 위에 내 KPT 텍스트만 반영해 저장(done 등 다른 필드는 원격값 유지).
  const commitRetro = async (owner) => {
    const mine = boardRef.current.retros?.[owner] || {};
    await loadBoard();
    const current = boardRef.current;
    const existing = current.retros?.[owner] || {};
    await saveBoard({
      ...current,
      retros: {
        ...current.retros,
        [owner]: { ...existing, keep: mine.keep || "", problem: mine.problem || "", try: mine.try || "" },
      },
    });
  };
  // 개인 단위 완료 토글. 완료해도 잠그지 않으며, 완료된 사람 KPT만 문서에 누적된다.
  const toggleRetroDone = async (owner) => {
    await loadBoard();
    const current = boardRef.current;
    const existing = current.retros?.[owner] || {};
    await saveBoard({ ...current, retros: { ...current.retros, [owner]: { ...existing, done: !existing.done } } });
  };
  // 우선순위 문제별 해결여부 선택 (누구나 변경 가능)
  const setPriorityResolution = async (noteId, value) => {
    await loadBoard();
    const current = boardRef.current;
    await saveBoard({ ...current, priorityResolution: { ...current.priorityResolution, [noteId]: value } });
  };
  // 회고 탭 상단 "우선순위 해결여부" 섹션 표시 토글 (누구나 켜고 끌 수 있음)
  const toggleRetroPriorityCheck = async () => {
    await loadBoard();
    const current = boardRef.current;
    const on = current.retroPriorityCheck !== false;
    await saveBoard({ ...current, retroPriorityCheck: !on });
  };
  // 문서 표준 필드(목적/배경/추진 방향/기대 효과) 저장. 안내 문구 편집과 동일 패턴(blur 시 저장).
  const updateDocField = async (field, value) => {
    await loadBoard();
    const current = boardRef.current;
    await saveBoard({ ...current, docFields: { ...(current.docFields || {}), [field]: value } });
  };

  // 포스트잇 내용을 타이핑하는 동안은 로컬 상태만 갱신 (폴링에 의해 지워지지 않도록)
  const editNoteTextLocal = (id, text) => {
    setBoard((prev) => ({
      ...prev,
      notes: prev.notes.map((n) => (n.id === id ? { ...n, text } : n)),
    }));
  };

  // 편집을 마치고 포커스를 벗어날 때(blur) 최신 원격 상태 위에 내 텍스트만 반영해 저장
  const commitNoteText = async (id) => {
    const myText = boardRef.current.notes.find((n) => n.id === id)?.text ?? "";
    await loadBoard();
    const current = boardRef.current;
    await saveBoard({
      ...current,
      notes: current.notes.map((n) => (n.id === id ? { ...n, text: myText } : n)),
    });
  };

  // 포스트잇 설명을 타이핑하는 동안은 로컬 상태만 갱신
  const editNoteDescriptionLocal = (id, description) => {
    setBoard((prev) => ({
      ...prev,
      notes: prev.notes.map((n) => (n.id === id ? { ...n, description } : n)),
    }));
  };

  // 설명 편집을 마칠 때 저장
  const commitNoteDescription = async (id) => {
    const myDescription = boardRef.current.notes.find((n) => n.id === id)?.description ?? "";
    await loadBoard();
    const current = boardRef.current;
    await saveBoard({
      ...current,
      notes: current.notes.map((n) => (n.id === id ? { ...n, description: myDescription } : n)),
    });
  };

  // 서로 다른 의견 보드(topic)에 속한 포스트잇은 함께 선택할 수 없게 막는다 -> 병합은 같은 주제 안에서만 의미가 있음
  const toggleSelect = (id, topicId) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length > 0) {
        const firstTopic = board.notes.find((n) => n.id === prev[0])?.topicId;
        if (firstTopic !== topicId) return prev;
      }
      return [...prev, id];
    });
  };

  const mergeSelected = async () => {
    if (selected.length < 2) return;
    await loadBoard();
    const current = boardRef.current;
    const chosen = current.notes.filter((n) => selected.includes(n.id));
    const rest = current.notes.filter((n) => !selected.includes(n.id));
    const votes = { ...current.votes };
    selected.forEach((id) => delete votes[id]); // 병합되어 사라지는 노트의 표는 정리
    const merged = {
      id: uid(),
      text: chosen.map((n) => n.text).join(" / "),
      authors: [...new Set(chosen.flatMap((n) => n.authors))],
      topicId: chosen[0].topicId,
      isProblem: false,
      isParked: false,
    };
    await saveBoard({ ...current, notes: [...rest, merged], votes });
    setSelected([]);
    setMergeMode(false);
  };

  const deleteNote = async (id) => {
    await loadBoard();
    const current = boardRef.current;
    const votes = { ...current.votes };
    delete votes[id];
    await saveBoard({ ...current, notes: current.notes.filter((n) => n.id !== id), votes });
  };

  // 6번: "문제로" 토글. 노트 자체에 isProblem을 표시(복제 없음). 해제 시 그 노트의 표는 정리.
  // 문제와 보류는 동시에 될 수 없으므로, 문제로 표시하면 보류 상태는 자동으로 해제한다.
  const toggleProblem = async (noteId) => {
    await loadBoard();
    const current = boardRef.current;
    const target = current.notes.find((n) => n.id === noteId);
    const willBeProblem = !target?.isProblem;
    const votes = { ...current.votes };
    if (!willBeProblem) delete votes[noteId];
    await saveBoard({
      ...current,
      notes: current.notes.map((n) =>
        n.id === noteId ? { ...n, isProblem: willBeProblem, isParked: willBeProblem ? false : n.isParked } : n
      ),
      votes,
    });
  };

  // 보류함 토글. isProblem과 동일한 패턴(플래그 하나, 복제 없음)을 따르되,
  // 원래 의견 보드 자리에는 그대로 남고 보류함 목록에도 함께 나타난다(표시만 두 곳).
  // 문제 상태와는 동시에 될 수 없으므로, 보류로 표시하면 문제 상태와 표는 함께 정리한다.
  const toggleParked = async (noteId) => {
    await loadBoard();
    const current = boardRef.current;
    const target = current.notes.find((n) => n.id === noteId);
    const willBeParked = !target?.isParked;
    const votes = { ...current.votes };
    if (willBeParked) delete votes[noteId];
    await saveBoard({
      ...current,
      notes: current.notes.map((n) =>
        n.id === noteId ? { ...n, isParked: willBeParked, isProblem: willBeParked ? false : n.isProblem } : n
      ),
      votes,
    });
  };

  // 보류함 항목 클릭 시 원래 속한 의견 보드로 스크롤 이동
  const scrollToTopic = (topicId) => {
    topicRefs.current[topicId]?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const setPhase = async (phase) => {
    await loadBoard();
    const current = boardRef.current;
    await saveBoard({ ...current, phase });
  };

  // 사용자별 총 투표 수를 계산 (여러 항목에 분산 가능, 단 항목당 1표로 제한)
  const myVoteCount = (b) =>
    Object.values(b.votes).reduce((sum, voters) => sum + (voters.includes(name) ? 1 : 0), 0);

  // 핵심 제약: 동일 인물이 같은 포스트잇에 중복 투표 불가(토글로 취소만 가능),
  // 전체 투표권(votesPerUser) 소진 시 새 항목에 투표 불가. 이제 note.id 기준.
  const toggleVote = async (noteId) => {
    if (!name) return;
    await loadBoard();
    const current = boardRef.current;
    const votersNow = current.votes[noteId] || [];
    const already = votersNow.includes(name);
    let nextVoters;
    if (already) {
      nextVoters = votersNow.filter((v) => v !== name);
    } else {
      if (myVoteCount(current) >= current.votesPerUser) return;
      nextVoters = [...votersNow, name];
    }
    await saveBoard({ ...current, votes: { ...current.votes, [noteId]: nextVoters } });
  };

  const setVotesPerUser = async (n) => {
    await loadBoard();
    const current = boardRef.current;
    await saveBoard({ ...current, votesPerUser: n });
  };

  // 브라우저의 SpeechRecognition 생성자 (크롬/엣지 등은 webkit 접두어 사용)
  const getSpeechRecognition = () =>
    typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

  // 마이크 음성 인식 시작. Web Speech API는 오직 마이크 입력만 인식한다
  // (탭/시스템 오디오는 이 API로 직접 캡처 불가). 온라인 회의라도 스피커로 나오는 소리를
  // 마이크가 음향적으로 함께 주워 담아 텍스트화된다.
  const startRecognition = () => {
    const SR = getSpeechRecognition();
    if (!SR) {
      setSpeechSupported(false);
      return;
    }
    const recognition = new SR();
    recognition.lang = "ko-KR";
    recognition.continuous = true; // 말이 잠깐 끊겨도 계속 듣는다
    recognition.interimResults = true; // 확정 전 임시 결과도 실시간으로 보여준다

    recognition.onresult = (event) => {
      let finalChunk = "";
      let interimChunk = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) finalChunk += res[0].transcript;
        else interimChunk += res[0].transcript;
      }
      // 확정 문장은 회의록 버퍼에 누적한다. 문장 사이에 공백을 넣어 붙는 것을 막는다.
      if (finalChunk) {
        const next = (minutesRef.current ? minutesRef.current + " " : "") + finalChunk.trim();
        minutesRef.current = next;
        setMinutes(next);
      }
      setMinutesInterim(interimChunk);
    };

    recognition.onerror = (event) => {
      // no-speech / aborted 등은 흔한 일이므로 조용히 넘어가고, 권한 거부만 사용자에게 알린다
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        wantRecordingRef.current = false;
        setMicRecording(false);
        setConfirmState({
          title: "마이크 권한 필요",
          message: "브라우저에서 마이크 사용이 차단되어 있습니다. 주소창의 자물쇠 아이콘에서 마이크를 허용해 주세요.",
          confirmLabel: "확인",
          onConfirm: () => setConfirmState(null),
        });
      }
    };

    // continuous라도 브라우저가 일정 시간 후 자동 종료할 수 있다.
    // 사용자가 여전히 "녹음 중"을 원하면 자동으로 다시 시작해 끊김 없이 이어 듣는다.
    recognition.onend = () => {
      // 모드 전환으로 교체된 옛 인스턴스는 재시작·상태변경에 관여하지 않는다(두 인식기 동시 실행 방지).
      if (recognitionRef.current !== recognition) return;
      if (wantRecordingRef.current) {
        try {
          recognition.start();
        } catch (e) {
          /* 이미 시작된 경우 등은 무시 */
        }
      } else {
        setMicRecording(false);
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setMicRecording(true);
    } catch (e) {
      /* 중복 start 예외 무시 */
    }
  };

  const stopRecognition = () => {
    wantRecordingRef.current = false;
    const recognition = recognitionRef.current;
    if (recognition) {
      try {
        recognition.stop();
      } catch (e) {
        /* noop */
      }
    }
    setMicRecording(false);
    setMinutesInterim("");
  };

  // 회의록 녹음 토글. board.recording은 참여자 모두에게 보이는 공유 "녹음 중" 배지이고,
  // 실제 음성 인식은 버튼을 누른 이 브라우저에서만 로컬로 동작한다.
  const toggleRecord = async () => {
    const SR = getSpeechRecognition();
    if (!SR) {
      setSpeechSupported(false);
      setConfirmState({
        title: "지원하지 않는 브라우저",
        message: "이 브라우저는 음성 인식(Web Speech API)을 지원하지 않습니다. Chrome 또는 Edge에서 이용해 주세요.",
        confirmLabel: "확인",
        onConfirm: () => setConfirmState(null),
      });
      return;
    }

    if (micRecording) {
      stopRecognition();
    } else {
      wantRecordingRef.current = true;
      startRecognition();
    }
    setMinutesOpen(true); // 결과 확인·저장용 패널을 확실히 보여준다

    // 공유 배지 갱신 + 누적 녹취록을 board에 저장해 문서/다른 참여자에 반영
    const nowRecording = !micRecording;
    await loadBoard();
    const current = boardRef.current;
    await saveBoard({ ...current, recording: nowRecording, minutes: minutesRef.current });
  };

  // ===== 회의록(minutes) 액션 =====
  const copyMinutes = async () => {
    try {
      await navigator.clipboard.writeText(minutesRef.current.trim());
    } catch (e) {
      /* 클립보드 권한 없을 때 조용히 무시 */
    }
  };

  // 전체 회의 녹취록을 .txt 파일로 다운로드
  const downloadMinutes = () => {
    const text = minutesRef.current.trim();
    if (!text) return;
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${selectedProject?.title || "회의록"}-회의록.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // 회의록 내용 지우기(문서에도 반영되도록 board.minutes까지 비운다)
  const clearMinutes = async () => {
    minutesRef.current = "";
    setMinutes("");
    setMinutesInterim("");
    await loadBoard();
    const current = boardRef.current;
    await saveBoard({ ...current, minutes: "" });
  };

  // 회의록 단순 정리(외부 API 없이 클라이언트에서만): 반복된 문장과 붙어서 중복된 단어를 걷어낸다.
  // ※ 요약/핵심 추출이 아니라 "잡음성 중복 제거" 수준이다. 결과는 문서 "회의 녹취록"에 그대로 반영된다.
  const cleanupMinutes = async () => {
    const raw = minutesRef.current || "";
    if (!raw.trim()) return;
    // 1) 문장 단위로 나눈다(문장부호/줄바꿈 기준). 부호가 없으면 통째로 한 덩어리가 된다.
    const segments = raw
      .split(/(?<=[.!?。？！])\s+|\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const seen = new Set();
    const out = [];
    for (let seg of segments) {
      // 2) 붙어서 반복된 동일 단어 축약: "그 그 그 안건" -> "그 안건"
      //    (\b는 한글에 안 먹으므로, 반복 토큰 뒤가 공백/끝인지 lookahead로 확인)
      seg = seg.replace(/(\S+)(?:\s+\1(?=\s|$))+/g, "$1").replace(/\s{2,}/g, " ").trim();
      // 3) 공백·문장부호를 무시한 정규화 기준으로 중복 문장 제거(첫 등장 순서 유지)
      const norm = seg.replace(/[\s.,!?。、·]/g, "").toLowerCase();
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      out.push(seg);
    }
    const cleaned = out.join("\n");
    if (cleaned === raw) return; // 바뀐 게 없으면 저장 생략
    minutesRef.current = cleaned;
    setMinutes(cleaned);
    await loadBoard();
    const current = boardRef.current;
    await saveBoard({ ...current, minutes: cleaned });
  };

  // 회의록 녹음 중이 아닐 때는 board.minutes(공유 저장본)를 로컬 버퍼에 동기화한다.
  // 이렇게 하면 새로고침·재접속 후에도 회의록 패널과 "이어서 녹음"이 이어진다.
  // (녹음 중에는 로컬이 실시간으로 자라므로 덮어쓰지 않는다.)
  useEffect(() => {
    if (micRecording) return; // 녹음 중에는 로컬 버퍼가 실시간으로 자라므로 덮어쓰지 않는다
    const bm = board.minutes || "";
    if (bm !== minutesRef.current) {
      minutesRef.current = bm;
      setMinutes(bm);
    }
  }, [board.minutes, micRecording]);

  // 컴포넌트 언마운트 시 인식이 계속 돌지 않도록 정리
  useEffect(() => {
    return () => {
      wantRecordingRef.current = false;
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch (e) {
          /* noop */
        }
      }
    };
  }, []);

  // "이미지로 저장": 현재 보고 있는 탭에 실제로 렌더링된 화면 전체(스크롤 영역 포함)를 그대로 캡처한다
  const downloadPhaseImage = async () => {
    const node = phaseContentRef.current;
    if (!node) return;
    const dataUrl = await toPng(node, { backgroundColor: "#ffffff", pixelRatio: 2 });
    const link = document.createElement("a");
    link.download = `${selectedProject.title}-${PHASE_LABELS[board.phase] || "화면"}.png`;
    link.href = dataUrl;
    link.click();
  };

  // 문서 탭 전용 "이미지로 저장": 토글/다운로드 버튼은 빼고 문서 내용(표)만 캡처한다
  const downloadDocImage = async () => {
    const node = docContentRef.current;
    if (!node) return;
    const dataUrl = await toPng(node, { backgroundColor: "#ffffff", pixelRatio: 2 });
    const link = document.createElement("a");
    link.download = `${selectedProject.title}-${docType === "result" ? "결과" : "과정"}문서.png`;
    link.href = dataUrl;
    link.click();
  };

  // 4번(문서): 표 중심 문서를 HTML 파일로 내려받기. docType으로 "과정" 문서와 "결과"(TOP 5) 문서를 구분한다.
  const downloadDoc = (type) => {
    const html = buildDocHtml(selectedProject, board, type);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.download = `${selectedProject.title}-${type === "result" ? "결과" : "과정"}문서.html`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
  };

  // 4번(문서): 표 중심 문서를 마크다운 파일로 내려받기 (노션·구글독스 등에 붙여넣기 좋음)
  const downloadDocMarkdown = (type) => {
    const md = buildDocMarkdown(selectedProject, board, type);
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.download = `${selectedProject.title}-${type === "result" ? "결과" : "과정"}문서.md`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
  };

  // ---- 화면 1: 프로젝트 목록 / 생성 ----
  if (!selectedProject) {
    return (
      <div>
        <TopBar onProjects={backToProjects} />
        <div style={{ maxWidth: 820, margin: "0 auto", padding: "40px 24px 80px" }}>
          <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-.03em", margin: "0 0 7px" }}>내 프로젝트</h1>
          <div style={{ fontSize: 15, color: "#8a857f", marginBottom: 28 }}>
            회의 하나가 프로젝트 하나입니다. 새로 시작하거나 이어서 진행하세요.
          </div>

          {/* 새 프로젝트 만들기 카드 */}
          <div style={{ background: "#fff", border: "1px solid rgba(36,35,34,.09)", borderRadius: 16, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,.05)", marginBottom: 28 }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <input
                value={newProjectTitle}
                onChange={(e) => setNewProjectTitle(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createProject()}
                placeholder="프로젝트 이름 (필수)"
                style={{ flex: "2 1 180px", border: "1px solid rgba(36,35,34,.14)", borderRadius: 10, padding: "12px 14px", fontSize: 14, outline: "none", boxSizing: "border-box" }}
              />
              <input
                value={newProjectGoal}
                onChange={(e) => setNewProjectGoal(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createProject()}
                placeholder="목표 한 줄 (선택)"
                style={{ flex: "3 1 220px", border: "1px solid rgba(36,35,34,.14)", borderRadius: 10, padding: "12px 14px", fontSize: 14, outline: "none", boxSizing: "border-box" }}
              />
              <button
                onClick={createProject}
                style={{ background: "#242322", color: "#fff", border: "none", borderRadius: 10, padding: "12px 20px", fontWeight: 600, fontSize: 14, cursor: "pointer", whiteSpace: "nowrap" }}
              >
                + 새 프로젝트
              </button>
            </div>
          </div>

          {projects === null && <div style={{ color: "#a19c95", fontSize: 14 }}>불러오는 중...</div>}
          {projects && projects.length === 0 && (
            <div style={{ color: "#a19c95", fontSize: 14, textAlign: "center", padding: "30px 0" }}>아직 생성된 프로젝트가 없습니다.</div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <AnimatePresence mode="popLayout">
            {projects &&
              [...projects]
                .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
                .map((p) => (
                <motion.div
                  key={p.id}
                  layout
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ duration: 0.2, ease: EASE }}
                  style={{
                    background: "#fff",
                    border: `1px solid ${p.pinned ? "rgba(234,185,122,.5)" : "rgba(36,35,34,.09)"}`,
                    borderRadius: 14,
                    padding: "18px 20px",
                    boxShadow: "0 1px 3px rgba(0,0,0,.04)",
                    display: "flex",
                    alignItems: "center",
                    gap: 16,
                  }}
                >
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      togglePinProject(p.id);
                    }}
                    title={p.pinned ? "고정 해제" : "고정"}
                    style={{ fontSize: 18, cursor: "pointer", flexShrink: 0, filter: p.pinned ? "none" : "grayscale(1) opacity(0.35)" }}
                  >
                    📌
                  </span>
                  <button
                    onClick={() => setSelectedProject(p)}
                    style={{ flex: 1, textAlign: "left", background: "none", border: "none", cursor: "pointer", padding: 0, minWidth: 0 }}
                  >
                    <div style={{ fontWeight: 700, fontSize: 16, letterSpacing: "-.01em", marginBottom: 7, color: "#242322" }}>{p.title}</div>
                    <div style={{ fontSize: 14, color: "#8a857f" }}>
                      {new Date(p.createdAt).toLocaleDateString("ko-KR")} 생성{p.goal ? ` · ${p.goal}` : ""}
                    </div>
                  </button>
                  <button
                    onClick={() => setSelectedProject(p)}
                    style={{ background: "#ffffff", border: "1px solid rgba(36,35,34,.1)", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "#242322", whiteSpace: "nowrap", flexShrink: 0 }}
                  >
                    열기
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmState({
                        title: "프로젝트 삭제",
                        message: `'${p.title}' 프로젝트를 삭제하시겠습니까?`,
                        confirmLabel: "삭제",
                        onConfirm: () => {
                          deleteProject(p.id);
                          setConfirmState(null);
                        },
                      });
                    }}
                    title="삭제"
                    style={{ background: "none", border: "none", cursor: "pointer", color: "#c4bfb8", padding: 6, flexShrink: 0, display: "flex" }}
                  >
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>
        <ConfirmDialog
          open={!!confirmState}
          title={confirmState?.title}
          message={confirmState?.message}
          confirmLabel={confirmState?.confirmLabel}
          onConfirm={confirmState?.onConfirm}
          onCancel={() => setConfirmState(null)}
        />
      </div>
    );
  }

  // ---- 화면 2: 참여자 이름 입력 ----
  if (!name) {
    return (
      <div>
        <TopBar onProjects={backToProjects} />
        <div style={{ minHeight: "70vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ width: "100%", maxWidth: 420, textAlign: "center" }}>
            <div style={{ display: "inline-flex", gap: 4, marginBottom: 22 }}>
              <span style={{ width: 13, height: 13, borderRadius: 4, background: "#f7d3de" }} />
              <span style={{ width: 13, height: 13, borderRadius: 4, background: "#bcd9ee" }} />
              <span style={{ width: 13, height: 13, borderRadius: 4, background: "#a9e6d3" }} />
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#8a857f", marginBottom: 8 }}>초대받은 프로젝트</div>
            <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-.02em", margin: "0 0 30px" }}>{selectedProject.title}</h1>
            <div style={{ background: "#fff", border: "1px solid rgba(36,35,34,.09)", borderRadius: 18, padding: 28, boxShadow: "0 2px 10px rgba(0,0,0,.05)" }}>
              <input
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && joinBoard()}
                placeholder="이름 또는 닉네임"
                style={{ width: "100%", border: "1px solid rgba(36,35,34,.14)", borderRadius: 11, padding: "14px 16px", fontSize: 16, outline: "none", textAlign: "center", marginBottom: 14, boxSizing: "border-box" }}
              />
              <button
                onClick={joinBoard}
                style={{ width: "100%", background: "#242322", color: "#fff", border: "none", borderRadius: 11, padding: 15, fontWeight: 700, fontSize: 16, cursor: "pointer" }}
              >
                참여하기
              </button>
              <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center", marginTop: 16, fontSize: 13, color: "#8a857f" }}>
                <span style={{ display: "flex", gap: 3 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 999, background: "#f7d3de" }} />
                  <span style={{ width: 9, height: 9, borderRadius: 999, background: "#dde3ba" }} />
                  <span style={{ width: 9, height: 9, borderRadius: 999, background: "#d6c9ee" }} />
                </span>
                이름을 입력하면 색상이 자동으로 배정됩니다
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const votesLeft = board.votesPerUser - myVoteCount(board);
  const problemNotesAll = board.notes.filter((n) => n.isProblem);
  const parkedNotesAll = board.notes.filter((n) => n.isParked); // 보류함: 모든 의견 보드를 통틀어 보류된 항목
  const rankedProblems = [...problemNotesAll].sort(
    (a, b) => (board.votes[b.id]?.length || 0) - (board.votes[a.id]?.length || 0)
  );
  const docModel = buildDocModel(selectedProject, board);
  const minutesRecording = micRecording; // 녹음은 회의록 한 종류뿐

  // 포스트잇 카드 렌더 (문제 그룹/일반 그룹에서 공통 사용)
  const renderNoteCard = (note) => {
    const isSel = selected.includes(note.id);
    const noteColor = board.users[note.authors[0]]?.color || PALETTE[0];
    const voters = board.votes[note.id] || [];
    const iVoted = voters.includes(name);
    const voteDisabled = !iVoted && votesLeft <= 0;
    return (
      <motion.div
        key={note.id}
        {...popIn}
        onClick={() => mergeMode && toggleSelect(note.id, note.topicId)}
        style={{
          flex: "0 0 190px",
          width: 190,
          maxWidth: "100%",
          background: noteColor.bg,
          color: "#242322",
          borderRadius: 6,
          boxShadow: "0 2px 8px rgba(36,35,34,.09)",
          border: isSel
            ? "2px solid #0066ff"
            : note.isProblem
            ? "2px solid #EA7D7A"
            : note.isParked
            ? "1px dashed rgba(36,35,34,.35)"
            : "1px solid rgba(36,35,34,.06)",
          cursor: mergeMode ? "pointer" : "default",
          display: "flex",
          flexDirection: "column",
          boxSizing: "border-box",
          padding: "12px 12px 8px",
          position: "relative",
        }}
      >
        {/* 병합 모드 선택 체크박스 */}
        {mergeMode && (
          <span
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              width: 18,
              height: 18,
              borderRadius: 5,
              border: `2px solid ${isSel ? "#0066ff" : "rgba(36,35,34,.3)"}`,
              background: isSel ? "#0066ff" : "rgba(255,255,255,.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontSize: 12,
              fontWeight: 800,
            }}
          >
            {isSel ? "✓" : ""}
          </span>
        )}
        {/* 삭제 × (편집 모드에서만) */}
        {!mergeMode && (
          <span
            onClick={(e) => {
              e.stopPropagation();
              deleteNote(note.id);
            }}
            style={{ position: "absolute", top: 6, right: 8, cursor: "pointer", color: "rgba(36,35,34,.4)", fontSize: 15, lineHeight: 1 }}
            title="삭제"
          >
            ×
          </span>
        )}

        {/* 4번: 병합 모드에서는 읽기전용 div, 아니면 자동 높이 textarea */}
        {mergeMode ? (
          <div
            style={{
              fontSize: 14.5,
              fontWeight: 500,
              lineHeight: 1.45,
              color: "#242322",
              minHeight: 20,
              paddingRight: 22,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {note.text || <span style={{ opacity: 0.5 }}>(빈 포스트잇)</span>}
          </div>
        ) : (
          <textarea
            autoFocus={justCreatedId === note.id}
            value={note.text}
            placeholder="자유롭게 적어보세요"
            ref={(el) => autoResizeTextarea(el)}
            onChange={(e) => {
              editNoteTextLocal(note.id, e.target.value);
              autoResizeTextarea(e.target);
            }}
            onFocus={() => {
              suspendPollRef.current = true;
            }}
            onBlur={() => {
              suspendPollRef.current = false;
              commitNoteText(note.id);
              setJustCreatedId(null);
            }}
            style={{
              width: "100%",
              border: "none",
              background: "transparent",
              resize: "none",
              overflow: "hidden",
              outline: "none",
              fontSize: 14.5,
              fontWeight: 500,
              lineHeight: 1.45,
              color: "#242322",
              padding: 0,
              paddingRight: 14,
              boxSizing: "border-box",
              wordBreak: "break-word",
            }}
          />
        )}

        {/* 하단: 작성자(좌) + 상태/투표(우) — 글자 수와 무관하게 카드 맨 아래에 고정 */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, marginTop: "auto", paddingTop: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "rgba(36,35,34,.55)" }}>{note.authors.join(", ")}</span>
          {!mergeMode && (
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              {/* 7번: 문제 포스트잇에 바로 투표 */}
              {note.isProblem && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleVote(note.id);
                  }}
                  disabled={voteDisabled}
                  title={voteDisabled ? "남은 투표권이 없습니다" : "투표"}
                  style={{
                    border: "none",
                    background: iVoted ? "#242322" : "rgba(255,255,255,.7)",
                    color: iVoted ? "#fff" : "#57534e",
                    borderRadius: 6,
                    fontSize: 11.5,
                    padding: "3px 9px",
                    cursor: voteDisabled ? "default" : "pointer",
                    opacity: voteDisabled ? 0.45 : 1,
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                  }}
                >
                  {iVoted ? "✓ 투표" : "투표"} {voters.length > 0 ? voters.length : ""}
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleProblem(note.id);
                }}
                title={note.isProblem ? "문제 표시 해제" : "문제로 표시"}
                style={{
                  border: "none",
                  background: "rgba(255,255,255,.65)",
                  color: note.isProblem ? "#57534e" : "#B52B1B",
                  borderRadius: 6,
                  fontSize: 12,
                  padding: "3px 8px",
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                {note.isProblem ? "해제" : "문제로"}
              </button>
              {/* 문제 포스트잇에는 보류 버튼을 숨겨 공간 확보 (문제/보류는 상호배타라 어차피 보류 시 문제 해제됨) */}
              {!note.isProblem && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleParked(note.id);
                  }}
                  title={note.isParked ? "보류 해제" : "나중에 다시 논의 (보류)"}
                  style={{
                    border: "none",
                    background: "rgba(255,255,255,.5)",
                    color: "#57534e",
                    borderRadius: 6,
                    fontSize: 12,
                    padding: "3px 8px",
                    cursor: "pointer",
                    fontWeight: 600,
                  }}
                >
                  {note.isParked ? "복귀" : "보류"}
                </button>
              )}
            </div>
          )}
        </div>
      </motion.div>
    );
  };

  // ---- 화면 3: 보드 본체 ----
  return (
    <div>
      <TopBar
        onProjects={backToProjects}
        onSaveImage={downloadPhaseImage}
        onMinutes={() => setMinutesOpen(true)}
        minutesRecording={minutesRecording}
        right={
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {/* 시안의 "녹음 중" 배지 (시각 표시 전용) */}
            {board.recording && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "#fdeaea", border: "1px solid #ffcaca", borderRadius: 999, padding: "6px 12px", fontSize: 12.5, fontWeight: 700, color: "#d32f2f" }}>
                <span style={{ width: 9, height: 9, borderRadius: 999, background: "#ff4242", animation: "oaRecPulse 1.1s ease-in-out infinite" }} />
                녹음 중
              </span>
            )}
            <span
              style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#f2f2f2", borderRadius: 999, padding: "5px 12px 5px 8px", fontSize: 13, fontWeight: 600, color: "#242322" }}
            >
              <span style={{ width: 15, height: 15, borderRadius: 999, background: myColor.bg, flexShrink: 0 }} />
              {name}
            </span>
            <button
              onClick={changeName}
              style={{ border: "1px solid rgba(36,35,34,.14)", background: "#fff", color: "#6f6b66", borderRadius: 999, padding: "5px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
            >
              다른 이름으로 참여
            </button>
          </div>
        }
      />
      <div style={{ maxWidth: 1120, margin: "0 auto", padding: "20px 24px 60px" }}>
        {/* 프로젝트 제목 + 참여자 수 */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
          <span style={{ fontSize: 19, fontWeight: 800, letterSpacing: "-.02em" }}>{selectedProject.title}</span>
          <span style={{ fontSize: 13, color: "#8a857f" }}>참여자 {Object.keys(board.users).length}명</span>
        </div>
        {/* 탭바: 언더라인 스타일 */}
        <div
          style={{
            display: "flex",
            gap: 2,
            marginBottom: 22,
            borderBottom: "1px solid rgba(36,35,34,.09)",
            flexWrap: "wrap",
          }}
        >
          {[
            { key: "opinion", label: "의견 작성" },
            { key: "problem", label: "문제 정리" },
            { key: "voting", label: "우선순위 결과" },
            { key: "retro", label: "회고" },
            { key: "document", label: "문서" },
          ].map((tab) => {
            const on = board.phase === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setPhase(tab.key)}
                style={{
                  padding: "13px 16px",
                  border: "none",
                  background: "none",
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: "pointer",
                  color: on ? "#242322" : "#8a857f",
                  borderBottom: `2px solid ${on ? "#242322" : "transparent"}`,
                  marginBottom: -1,
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div ref={phaseContentRef} style={{ position: "relative", background: "#ffffff" }}>
        <AnimatePresence initial={false}>
        {board.phase === "opinion" && (
          <motion.div key="opinion" {...fadeSlide}>
            {/* 안내 문구 배너: 왼쪽 STEP 라벨 + 편집 가능한 안내 문구 (글자 수에 맞춰 자동 높이) */}
            <div style={{ background: "#242322", borderRadius: 16, padding: "18px 22px", marginBottom: 12, display: "flex", alignItems: "flex-start", gap: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: ".05em", color: "#a9e6d3", whiteSpace: "nowrap", paddingTop: 2, textAlign: "center", flexShrink: 0 }}>
                STEP 1<br />·<br />의견 작성
              </div>
              <textarea
                defaultValue={board.instructions}
                ref={(el) => autoResizeTextarea(el)}
                onInput={(e) => autoResizeTextarea(e.target)}
                onFocus={() => {
                  suspendPollRef.current = true;
                }}
                onBlur={(e) => {
                  suspendPollRef.current = false;
                  updateInstructions(e.target.value);
                }}
                style={{
                  flex: 1,
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  resize: "none",
                  overflow: "hidden",
                  color: "#e7e4df",
                  fontSize: 14.5,
                  lineHeight: 1.6,
                  boxSizing: "border-box",
                }}
              />
            </div>

            {/* 2번: 프로젝트 목표 한 줄 고정. goal이 없으면 영역 자체를 표시하지 않는다. */}
            {selectedProject.goal && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 18, fontSize: 14.5, fontWeight: 600, color: "#242322", background: "#fff", border: "1px solid rgba(36,35,34,.1)", borderLeft: "3px solid #eecd9c", borderRadius: 10, padding: "11px 16px" }}>
                <span style={{ flexShrink: 0 }}>🎯 목표 :</span>
                <input
                  key={selectedProject.goal}
                  defaultValue={selectedProject.goal}
                  onBlur={(e) => updateProjectGoal(e.target.value.trim() || selectedProject.goal)}
                  style={{ flex: 1, border: "none", background: "transparent", outline: "none", fontWeight: 500, color: "#57534e", minWidth: 0, fontSize: 14.5 }}
                />
              </div>
            )}

            {/* 참여자 색상 범례 (툴바) */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16, alignItems: "center" }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#8a857f", marginRight: 2, marginLeft: 4 }}>참여자</span>
              {Object.entries(board.users).map(([uname, u]) => (
                <span
                  key={uname}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#f2f2f2", borderRadius: 999, padding: "5px 12px 5px 7px", fontSize: 13, fontWeight: 600, color: "#242322" }}
                >
                  <span style={{ width: 16, height: 16, borderRadius: 999, background: u.color.bg, flexShrink: 0 }} />
                  {uname}
                </span>
              ))}
            </div>

            {/* 툴바: 투표 안내(좌) + 보드 추가/병합 모드(우) */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
              <div data-guide="vote-status" style={{ fontSize: 13, color: "#8a857f" }}>
                투표: 남은 <b style={{ color: "#4f3fd6" }}>{Math.max(0, votesLeft)}</b> / {board.votesPerUser}표 · <span style={{ color: "#B52B1B", fontWeight: 700 }}>문제</span>로 표시된 포스트잇에 투표할 수 있어요
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  data-guide="merge"
                  onClick={() => {
                    setMergeMode((m) => !m);
                    setSelected([]);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    padding: "8px 14px",
                    borderRadius: 9,
                    border: `1px solid ${mergeMode ? "#bcd9ee" : "rgba(36,35,34,.14)"}`,
                    background: mergeMode ? "#eef4fb" : "#fff",
                    color: mergeMode ? "#0b57b8" : "#242322",
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                  }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
                  </svg>
                  {mergeMode ? "병합 모드 종료" : "병합 모드"}
                </button>
              </div>
            </div>

            {/* 병합 모드 안내 바 */}
            {mergeMode && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, background: "#eef4fb", border: "1px solid #bcd9ee", borderRadius: 10, padding: "10px 16px", marginBottom: 16 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#0b57b8" }}>
                  같은 보드 안에서 합칠 포스트잇을 2개 이상 선택하세요 · {selected.length}개 선택됨
                </span>
                {selected.length >= 2 && (
                  <button
                    onClick={mergeSelected}
                    style={{ background: "#0066ff", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}
                  >
                    선택 병합
                  </button>
                )}
              </div>
            )}

            {/* 의견 보드들을 세로로 쌓는다. 각 보드 안에서 포스트잇은 좌->우로 채워지고 줄이 차면 다음 줄로(5번). */}
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              {board.topics.map((topic, topicIdx) => {
                const topicNotes = board.notes.filter((n) => n.topicId === topic.id);
                const problemNotes = topicNotes.filter((n) => n.isProblem); // 6번: 상단 고정
                const plainNotes = topicNotes.filter((n) => !n.isProblem && !n.isParked);
                // 보류된 포스트잇은 문제 섹션과 동일한 패턴으로, 일반 포스트잇 아래에 별도 구획으로 묶어 보여준다
                const parkedNotes = topicNotes.filter((n) => !n.isProblem && n.isParked);
                const canDelete = board.topics.length > 1;
                return (
                  <div
                    key={topic.id}
                    ref={(el) => {
                      topicRefs.current[topic.id] = el;
                    }}
                    {...(topicIdx === 0 ? { "data-guide": "note-board" } : {})}
                    style={{
                      width: "100%",
                      background: "#fff",
                      border: "1px solid rgba(36,35,34,.08)",
                      borderRadius: 18,
                      padding: 20,
                      boxShadow: "0 1px 3px rgba(0,0,0,.04)",
                      boxSizing: "border-box",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, gap: 8 }}>
                      <input
                        defaultValue={topic.title}
                        onBlur={(e) => renameTopic(topic.id, e.target.value.trim() || topic.title)}
                        style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-.01em", color: "#242322", border: "none", background: "transparent", outline: "none", flex: 1, minWidth: 0 }}
                      />
                      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                        {/* 3번: 보드 삭제 (마지막 1개는 삭제 불가) */}
                        {canDelete && (
                          <button
                            onClick={() => requestDeleteTopic(topic)}
                            title={problemNotes.length + plainNotes.length + parkedNotes.length === 0 ? "빈 보드 삭제" : "보드 삭제"}
                            style={{ border: "1px solid rgba(36,35,34,.1)", background: "#fff", color: "#a19c95", borderRadius: 9, padding: "7px 11px", cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}
                          >
                            보드 삭제
                          </button>
                        )}
                        <button
                          data-guide="add-note"
                          onClick={() => createBlankNote(topic.id)}
                          style={{ padding: "7px 13px", borderRadius: 9, border: "1px dashed rgba(36,35,34,.22)", background: "#ffffff", color: "#57534e", fontWeight: 600, cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" }}
                        >
                          + 포스트잇
                        </button>
                      </div>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 14,
                        overflowX: "hidden",
                      }}
                    >
                      {/* 6번: 문제로 표시된 포스트잇을 보드 상단에 별도 구획(빨강 점선)으로 고정 */}
                      {problemNotes.length > 0 && (
                        <div style={{ border: "1px dashed #EA7A7A", borderRadius: 12, padding: "12px 12px 12px", background: "#FDF2EE" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14, fontWeight: 700, color: "#B5271B", marginBottom: 10, paddingLeft: 2 }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                              <line x1="12" y1="9" x2="12" y2="13" />
                              <line x1="12" y1="17" x2="12.01" y2="17" />
                            </svg>
                            문제로 표시됨
                          </div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                            <AnimatePresence mode="popLayout">{problemNotes.map(renderNoteCard)}</AnimatePresence>
                          </div>
                        </div>
                      )}
                      {/* 5번: 일반 포스트잇은 flex-wrap으로 좌->우 채우고 줄바꿈 (가로 스크롤 없음) */}
                      {plainNotes.length > 0 && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                          <AnimatePresence mode="popLayout">{plainNotes.map(renderNoteCard)}</AnimatePresence>
                        </div>
                      )}
                      {/* 1번: 보류된 포스트잇은 일반 포스트잇 아래에 별도 구획으로 고정 */}
                      {parkedNotes.length > 0 && (
                        <div style={{ border: "1px dashed rgba(36,35,34,.18)", borderRadius: 12, padding: "12px 12px 12px", background: "#ffffff" }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "#8a857f", marginBottom: 10, paddingLeft: 2 }}>⏸ 보류된 의견</div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                            <AnimatePresence mode="popLayout">{parkedNotes.map(renderNoteCard)}</AnimatePresence>
                          </div>
                        </div>
                      )}
                      {topicNotes.length === 0 && (
                        <div style={{ color: "#a19c95", fontSize: 13, padding: 6 }}>아직 포스트잇이 없습니다. "+ 포스트잇"을 눌러 시작하세요.</div>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* 시안처럼 의견 보드 추가 버튼을 보드 목록 맨 아래에 전체폭 점선 버튼으로 배치 */}
              <button
                onClick={addTopic}
                style={{
                  background: "none",
                  border: "1.5px dashed rgba(36,35,34,.2)",
                  borderRadius: 14,
                  padding: 16,
                  fontSize: 15,
                  fontWeight: 600,
                  color: "#8a857f",
                  cursor: "pointer",
                }}
              >
                + 새 의견 보드
              </button>
            </div>

            {/* 1번: 보류함. 원래 보드 자리에는 그대로 남기고(위 parkedNotes 구획에 포함), 전체 프로젝트 기준으로 모아 보여주는 접이식 섹션 */}
            <div style={{ marginTop: 22, background: "#fff", border: "1px solid rgba(36,35,34,.08)", borderRadius: 14, overflow: "hidden" }}>
              <button
                onClick={() => setParkingOpen((v) => !v)}
                style={{
                  width: "100%",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "15px 20px",
                  border: "none",
                  background: "none",
                  color: "#242322",
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  📥 보류함
                  <span style={{ background: "#eeeeee", color: "#8a857f", borderRadius: 999, padding: "1px 9px", fontSize: 12, fontWeight: 700 }}>{parkedNotesAll.length}</span>
                </span>
                <span style={{ fontSize: 13, color: "#8a857f", transform: parkingOpen ? "rotate(180deg)" : "rotate(0)", transition: "transform .15s" }}>▾</span>
              </button>
              <AnimatePresence>
              {parkingOpen && (
                <motion.div
                  key="parking-content"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.22, ease: EASE }}
                  style={{
                    borderTop: "1px solid rgba(36,35,34,.07)",
                    overflow: "hidden",
                  }}
                >
                  <div style={{ padding: "14px 20px 18px", display: "flex", flexDirection: "column", gap: 8 }}>
                  {parkedNotesAll.length === 0 && (
                    <div style={{ color: "#a19c95", fontSize: 13, padding: "16px 0", textAlign: "center" }}>보류한 의견이 없습니다.</div>
                  )}
                  <AnimatePresence mode="popLayout">
                  {parkedNotesAll.map((n) => {
                    const topicTitle = board.topics.find((t) => t.id === n.topicId)?.title || "";
                    const nColor = board.users[n.authors[0]]?.color || PALETTE[0];
                    return (
                      <motion.div
                        key={n.id}
                        {...popIn}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 6,
                          padding: "10px 14px",
                          borderRadius: 10,
                          background: "#f7f7f7",
                        }}
                      >
                        <div
                          onClick={() => scrollToTopic(n.topicId)}
                          title="원래 의견 보드로 이동"
                          style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, cursor: "pointer" }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
                            <span style={{ width: 12, height: 12, borderRadius: 999, flexShrink: 0, background: nColor.bg }} />
                            <span style={{ fontSize: 14.5, color: "#57534e", wordBreak: "break-word", flex: 1 }}>
                              {n.text || <span style={{ color: "#a19c95" }}>(빈 포스트잇)</span>}
                            </span>
                            <span style={{ fontSize: 13, color: "#a19c95", flexShrink: 0 }}>{topicTitle}</span>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleParked(n.id);
                            }}
                            style={{
                              border: "1px solid rgba(36,35,34,.12)",
                              background: "#fff",
                              color: "#242322",
                              borderRadius: 7,
                              fontSize: 13,
                              fontWeight: 600,
                              padding: "6px 11px",
                              cursor: "pointer",
                              flexShrink: 0,
                              whiteSpace: "nowrap",
                            }}
                          >
                            의견으로 되돌리기
                          </button>
                        </div>
                        {/* 보류된 이유: "문제" 설명과 동일하게 note.description을 재사용 */}
                        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                          <span style={{ fontSize: 12, color: "#a19c95", flexShrink: 0, marginTop: 6 }}>이유 :</span>
                          <textarea
                            value={n.description || ""}
                            ref={(el) => autoResizeTextarea(el)}
                            onChange={(e) => {
                              editNoteDescriptionLocal(n.id, e.target.value);
                              autoResizeTextarea(e.target);
                            }}
                            onFocus={() => {
                              suspendPollRef.current = true;
                            }}
                            onBlur={() => {
                              suspendPollRef.current = false;
                              commitNoteDescription(n.id);
                            }}
                            placeholder="보류된 이유를 입력하세요"
                            style={{ flex: 1, border: "none", background: "transparent", resize: "none", overflow: "hidden", fontSize: 13, fontFamily: "sans-serif", outline: "none", minHeight: 32 }}
                          />
                        </div>
                      </motion.div>
                    );
                  })}
                  </AnimatePresence>
                  </div>
                </motion.div>
              )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}

        {board.phase === "problem" && (
          <motion.div key="problem" {...fadeSlide}>
            {/* STEP 2 배너 */}
            <div style={{ background: "#242322", borderRadius: 16, padding: "18px 22px", marginBottom: 20, display: "flex", alignItems: "flex-start", gap: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: ".05em", color: "#bcd9ee", whiteSpace: "nowrap", paddingTop: 2, textAlign: "center", flexShrink: 0 }}>
                STEP 2<br />·<br />문제 정리
              </div>
              <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: "#e7e4df" }}>
                여러 보드에서 <b style={{ color: "#fff" }}>"문제로"</b> 표시한 의견을 한곳에 모았습니다. 문구를 다듬고, 필요하면 배경 설명을 덧붙이세요.
                <br />다음 단계에서 이 목록으로 투표합니다.
              </p>
            </div>
            {problemNotesAll.length === 0 && (
              <div style={{ textAlign: "center", padding: "60px 20px", color: "#a19c95", fontSize: 14 }}>
                아직 문제로 표시된 의견이 없습니다.
                <br />의견 작성 탭에서 "문제로"를 눌러 추가하세요.
              </div>
            )}
            <div {...(problemNotesAll.length > 0 && { "data-guide": "problem-area" })} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {problemNotesAll.map((n, i) => {
                const topicTitle = board.topics.find((t) => t.id === n.topicId)?.title || "";
                return (
                  <div key={n.id} style={{ background: "#fff", border: "1px solid rgba(36,35,34,.09)", borderRadius: 14, padding: "18px 20px", boxShadow: "0 1px 3px rgba(0,0,0,.04)", display: "flex", gap: 16 }}>
                    <span style={{ width: 30, height: 30, borderRadius: 8, color: "#1B65B5", fontWeight: 800, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, background: "#EEF0FD" }}>
                      {i + 1}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9, flexWrap: "wrap" }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "#f2f2f2", borderRadius: 999, padding: "3px 10px", fontSize: 13, fontWeight: 600, color: "#8a857f" }}>
                          원본 : {topicTitle}
                        </span>
                        <button
                          onClick={() => toggleProblem(n.id)}
                          title="문제 표시 해제 (포스트잇은 유지)"
                          style={{ border: "1px solid rgba(36,35,34,.1)", background: "#fff", color: "#a19c95", borderRadius: 7, fontSize: 12, fontWeight: 600, padding: "3px 9px", cursor: "pointer", marginLeft: "auto" }}
                        >
                          문제 해제
                        </button>
                      </div>
                      <textarea
                        value={n.text}
                        ref={(el) => autoResizeTextarea(el)}
                        onChange={(e) => {
                          editNoteTextLocal(n.id, e.target.value);
                          autoResizeTextarea(e.target);
                        }}
                        onFocus={() => {
                          suspendPollRef.current = true;
                        }}
                        onBlur={() => {
                          suspendPollRef.current = false;
                          commitNoteText(n.id);
                        }}
                        placeholder="문제 문구 — 무엇이 문제인가요? (원본 포스트잇과 연동)"
                        style={{ width: "100%", border: "none", borderBottom: "1px solid transparent", resize: "none", overflow: "hidden", fontSize: 16.5, fontWeight: 700, color: "#242322", outline: "none", padding: "2px 0 6px", boxSizing: "border-box", lineHeight: 1.4 }}
                      />
                      <textarea
                        value={n.description || ""}
                        ref={(el) => autoResizeTextarea(el)}
                        onChange={(e) => {
                          editNoteDescriptionLocal(n.id, e.target.value);
                          autoResizeTextarea(e.target);
                        }}
                        onFocus={() => {
                          suspendPollRef.current = true;
                        }}
                        onBlur={() => {
                          suspendPollRef.current = false;
                          commitNoteDescription(n.id);
                        }}
                        placeholder="부가 설명 추가 (선택) — 왜 문제인지, 어떤 상황인지"
                        style={{ width: "100%", border: "none", resize: "none", overflow: "hidden", fontSize: 14, color: "#6f6b66", outline: "none", padding: "6px 0 0", boxSizing: "border-box", lineHeight: 1.5 }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}

        {board.phase === "voting" && (
          <motion.div key="voting" {...fadeSlide}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20, flexWrap: "wrap", gap: 16 }}>
              <div>
                <h2 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.02em", margin: "0 0 4px" }}>우선순위 결과</h2>
                <p style={{ fontSize: 13.5, color: "#8a857f", margin: 0 }}>
                  득표순 정렬 · 내 남은 투표권 <b style={{ color: "#4f3fd6" }}>{Math.max(0, votesLeft)}</b>표
                </p>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, background: "#fff", border: "1px solid rgba(36,35,34,.1)", borderRadius: 10, padding: "8px 12px" }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#57534e" }}>1인당 투표권</span>
                <button
                  onClick={() => setVotesPerUser(Math.max(1, board.votesPerUser - 1))}
                  style={{ width: 26, height: 26, borderRadius: 7, border: "1px solid rgba(36,35,34,.14)", background: "#fff", fontSize: 16, fontWeight: 700, cursor: "pointer", lineHeight: 1, color: "#242322" }}
                >
                  −
                </button>
                <span style={{ fontWeight: 800, fontSize: 15, minWidth: 16, textAlign: "center" }}>{board.votesPerUser}</span>
                <button
                  onClick={() => setVotesPerUser(Math.min(10, board.votesPerUser + 1))}
                  style={{ width: 26, height: 26, borderRadius: 7, border: "1px solid rgba(36,35,34,.14)", background: "#fff", fontSize: 16, fontWeight: 700, cursor: "pointer", lineHeight: 1, color: "#242322" }}
                >
                  +
                </button>
              </div>
            </div>
            {rankedProblems.length === 0 && (
              <div style={{ textAlign: "center", padding: "60px 20px", color: "#a19c95", fontSize: 14 }}>
                투표할 문제가 없습니다. 먼저 의견 작성 탭에서 "문제로" 표시하고 투표하세요.
              </div>
            )}
            {(() => {
              const maxV = Math.max(1, ...rankedProblems.map((p) => (board.votes[p.id] || []).length));
              return (
                <div data-guide="vote-area" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {rankedProblems.map((p, i) => {
                    const voters = board.votes[p.id] || [];
                    const first = i === 0 && voters.length > 0;
                    // 디자인(Onalign.dc.html) 반영: 카드마다 투표 토글 버튼.
                    // 투표함 -> 어두운색(취소 가능), 투표 안 함 & 투표권 남음 -> 보라색, 투표권 소진 -> 비활성 회색.
                    const iVoted = voters.includes(name);
                    const canVote = votesLeft > 0;
                    const voteDisabled = !iVoted && !canVote;
                    const voteBtnBg = iVoted ? "#242322" : canVote ? "#5b4dde" : "#f0ede8";
                    const voteBtnFg = iVoted ? "#fff" : canVote ? "#fff" : "#b0aba4";
                    const voteBtnBorder = iVoted ? "#242322" : canVote ? "#5b4dde" : "rgba(36,35,34,.08)";
                    return (
                      <div
                        key={p.id}
                        style={{
                          background: first ? "#f5f3fe" : "#fff",
                          border: `1px solid ${first ? "#a99bf2" : "rgba(36,35,34,.09)"}`,
                          borderRadius: 14,
                          padding: "18px 20px",
                          boxShadow: first ? "0 4px 14px rgba(120,95,235,.25)" : "0 1px 3px rgba(0,0,0,.04)",
                          display: "flex",
                          alignItems: "center",
                          gap: 18,
                        }}
                      >
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 44, flexShrink: 0 }}>
                          {first && <span style={{ fontSize: 11, fontWeight: 700, color: "#4f3fd6" }}>1위</span>}
                          <span style={{ fontSize: 28, fontWeight: 800, lineHeight: 1, color: first ? "#4f3fd6" : "#bcbcbc" }}>{i + 1}</span>
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 16.5, fontWeight: 700, letterSpacing: "-.01em", marginBottom: p.description ? 4 : 8 }}>{p.text}</div>
                          {p.description && <div style={{ fontSize: 14, color: "#8a857f", marginBottom: 9 }}>{p.description}</div>}
                          <div style={{ height: 8, background: "#eeeeee", borderRadius: 999, overflow: "hidden", marginBottom: 9 }}>
                            <div style={{ height: "100%", borderRadius: 999, background: first ? "#8a7cf0" : "#c4c4c4", width: `${Math.round((voters.length / maxV) * 100)}%` }} />
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <div style={{ display: "flex" }}>
                              {voters.map((v) => {
                                const c = board.users[v]?.color || PALETTE[0];
                                return <span key={v} title={v} style={{ width: 18, height: 18, borderRadius: 999, border: "2px solid #fff", marginLeft: -5, background: c.bg, display: "inline-block" }} />;
                              })}
                            </div>
                            <span style={{ fontSize: 12.5, color: "#8a857f", fontWeight: 600 }}>{voters.length}표</span>
                          </div>
                        </div>
                        <button
                          onClick={() => toggleVote(p.id)}
                          disabled={voteDisabled}
                          title={voteDisabled ? "투표권을 모두 사용했습니다" : iVoted ? "투표 취소" : "투표"}
                          style={{
                            background: voteBtnBg,
                            color: voteBtnFg,
                            border: `1px solid ${voteBtnBorder}`,
                            borderRadius: 9,
                            padding: "9px 15px",
                            fontSize: 13,
                            fontWeight: 700,
                            cursor: voteDisabled ? "not-allowed" : "pointer",
                            whiteSpace: "nowrap",
                            flexShrink: 0,
                          }}
                        >
                          {iVoted ? "투표 취소" : "투표"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </motion.div>
        )}

        {board.phase === "retro" && (
          <motion.div key="retro" {...fadeSlide}>
            {/* STEP 5 배너 */}
            <div style={{ background: "#242322", borderRadius: 16, padding: "18px 22px", marginBottom: 20, display: "flex", alignItems: "flex-start", gap: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: ".05em", color: "#d6c9ee", whiteSpace: "nowrap", paddingTop: 2, textAlign: "center", flexShrink: 0 }}>
                STEP 5<br />·<br />회고
              </div>
              <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: "#e7e4df" }}>
                각자 <b style={{ color: "#fff" }}>Keep · Problem · Try</b>를 적고 "완료"를 눌러 주세요. 완료한 사람의 회고만 문서에 반영됩니다.
                <br />완료 후에도 자유롭게 수정할 수 있고, 수정하면 문서에도 자동으로 갱신됩니다.
              </p>
            </div>

            {/* 우선순위 해결여부 점검 토글 (누구나 켜고 끌 수 있음, 기본 ON) */}
            <div data-guide="retro-priority" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, background: "#fff", border: "1px solid rgba(36,35,34,.1)", borderRadius: 12, padding: "14px 18px", marginBottom: 16, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>우선순위 해결여부 점검</div>
                <div style={{ fontSize: 13, color: "#8a857f", marginTop: 2 }}>우선순위 결과에서 정한 문제들이 이번에 해결됐는지 함께 확인합니다.</div>
              </div>
              <button
                onClick={toggleRetroPriorityCheck}
                role="switch"
                aria-checked={board.retroPriorityCheck !== false}
                title="우선순위 해결여부 섹션 표시/숨김"
                style={{
                  width: 46,
                  height: 26,
                  borderRadius: 999,
                  border: "none",
                  cursor: "pointer",
                  flexShrink: 0,
                  background: board.retroPriorityCheck !== false ? "#5b4dde" : "#d5d1cb",
                  position: "relative",
                  padding: 0,
                }}
              >
                <span style={{ position: "absolute", top: 3, left: board.retroPriorityCheck !== false ? 23 : 3, width: 20, height: 20, borderRadius: 999, background: "#fff", transition: "left .15s ease", boxShadow: "0 1px 3px rgba(0,0,0,.25)" }} />
              </button>
            </div>

            {/* 우선순위 해결여부 목록 (ON일 때만, KPT 칸 위쪽) */}
            {board.retroPriorityCheck !== false && (
              <div style={{ marginBottom: 22 }}>
                {rankedProblems.length === 0 ? (
                  <div style={{ background: "#fff", border: "1px solid rgba(36,35,34,.09)", borderRadius: 12, padding: "16px 18px", color: "#a19c95", fontSize: 13.5 }}>
                    우선순위로 정리된 문제가 없습니다. "문제 정리 → 우선순위 결과"에서 먼저 진행하세요.
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {rankedProblems.map((p, i) => {
                      const cur = board.priorityResolution?.[p.id] || "";
                      return (
                        <div key={p.id} style={{ background: "#fff", border: "1px solid rgba(36,35,34,.09)", borderRadius: 12, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 15, fontWeight: 800, color: "#bcbcbc", width: 22, flexShrink: 0, textAlign: "center" }}>{i + 1}</span>
                          <span style={{ flex: 1, minWidth: 140, fontSize: 14.5, fontWeight: 600 }}>{p.text}</span>
                          <div style={{ display: "inline-flex", background: "#f2f0ec", borderRadius: 9, padding: 3, gap: 2, flexShrink: 0 }}>
                            {[
                              ["resolved", "해결됨", "#1e7a4d"],
                              ["partial", "부분해결", "#9a6a15"],
                              ["unresolved", "미해결", "#c0392b"],
                            ].map(([val, label, activeColor]) => {
                              const on = cur === val;
                              return (
                                <button
                                  key={val}
                                  onClick={() => setPriorityResolution(p.id, val)}
                                  style={{
                                    border: "none",
                                    borderRadius: 7,
                                    padding: "6px 12px",
                                    fontSize: 12.5,
                                    fontWeight: 700,
                                    cursor: "pointer",
                                    background: on ? "#fff" : "transparent",
                                    color: on ? activeColor : "#8a857f",
                                    boxShadow: on ? "0 1px 2px rgba(0,0,0,.12)" : "none",
                                  }}
                                >
                                  {label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* 참여자별 KPT 입력 칸 (참여자 수만큼, 본인 칸만 편집 가능) */}
            <div data-guide="retro-kpt" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
              {Object.entries(board.users).length === 0 ? (
                <div style={{ color: "#a19c95", fontSize: 14 }}>참여자가 없습니다.</div>
              ) : (
                Object.entries(board.users).map(([owner, u]) => {
                  const mineCell = owner === name;
                  const r = board.retros?.[owner] || {};
                  const done = !!r.done;
                  const col = u.color || PALETTE[0];
                  const kptField = (field, label, placeholder) => (
                    <div style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#8a857f", marginBottom: 4 }}>{label}</div>
                      <textarea
                        value={r[field] || ""}
                        readOnly={!mineCell}
                        ref={(el) => autoResizeTextarea(el)}
                        onInput={(e) => autoResizeTextarea(e.target)}
                        onChange={mineCell ? (e) => { editRetroLocal(owner, field, e.target.value); autoResizeTextarea(e.target); } : undefined}
                        onFocus={mineCell ? () => { suspendPollRef.current = true; } : undefined}
                        onBlur={mineCell ? () => { suspendPollRef.current = false; commitRetro(owner); } : undefined}
                        placeholder={mineCell ? placeholder : "—"}
                        style={{ width: "100%", boxSizing: "border-box", border: "1px solid rgba(36,35,34,.12)", borderRadius: 8, padding: "8px 10px", resize: "none", overflow: "hidden", fontSize: 13.5, fontFamily: "inherit", lineHeight: 1.5, outline: "none", minHeight: 34, background: mineCell ? "#fff" : "#faf9f7", color: "#242322" }}
                      />
                    </div>
                  );
                  return (
                    <div key={owner} style={{ background: "#fff", border: `1px solid ${done ? "rgba(114,201,172,.6)" : "rgba(36,35,34,.09)"}`, borderRadius: 14, padding: "16px 18px", boxShadow: "0 1px 3px rgba(0,0,0,.04)", display: "flex", flexDirection: "column" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                        <span style={{ width: 15, height: 15, borderRadius: 999, background: col.bg, flexShrink: 0 }} />
                        <span style={{ fontSize: 14.5, fontWeight: 700 }}>{owner}</span>
                        {mineCell && <span style={{ fontSize: 11, color: "#8a857f" }}>(나)</span>}
                        {done && (
                          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4, background: "#e6f7f1", color: "#1e7a4d", border: "1px solid #a9e6d3", borderRadius: 999, padding: "3px 9px", fontSize: 11.5, fontWeight: 700 }}>
                            ✓ 완료
                          </span>
                        )}
                      </div>
                      {kptField("keep", "Keep — 잘된 점", "계속 유지하고 싶은 점")}
                      {kptField("problem", "Problem — 아쉬운 점", "문제였던 점")}
                      {kptField("try", "Try — 시도할 점", "다음에 시도해볼 점")}
                      {mineCell && (
                        <button
                          onClick={() => toggleRetroDone(owner)}
                          style={{ marginTop: 4, alignSelf: "flex-end", padding: "8px 16px", borderRadius: 8, border: done ? "1px solid rgba(36,35,34,.14)" : "none", background: done ? "#fff" : "#242322", color: done ? "#242322" : "#fff", cursor: "pointer", fontSize: 13, fontWeight: 700 }}
                        >
                          {done ? "완료 취소" : "완료"}
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </motion.div>
        )}

        {board.phase === "document" && (
          <motion.div key="document" {...fadeSlide}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
              {/* 세그먼트 토글 (과정 / 결과) */}
              <div style={{ display: "inline-flex", borderRadius: 11, padding: 4, background: "#eeeeee" }}>
                <button
                  data-guide="doc-type-process"
                  onClick={() => setDocType("process")}
                  style={{
                    border: "none",
                    borderRadius: 8,
                    padding: "9px 20px",
                    fontSize: 14,
                    fontWeight: 700,
                    cursor: "pointer",
                    background: docType === "process" ? "#fff" : "transparent",
                    color: docType === "process" ? "#242322" : "#8a857f",
                    boxShadow: docType === "process" ? "0 1px 2px rgba(0,0,0,.1)" : "none",
                  }}
                >
                  과정 문서
                </button>
                <button
                  data-guide="doc-type-result"
                  onClick={() => setDocType("result")}
                  style={{
                    border: "none",
                    borderRadius: 8,
                    padding: "9px 20px",
                    fontSize: 14,
                    fontWeight: 700,
                    cursor: "pointer",
                    background: docType === "result" ? "#fff" : "transparent",
                    color: docType === "result" ? "#242322" : "#8a857f",
                    boxShadow: docType === "result" ? "0 1px 2px rgba(0,0,0,.1)" : "none",
                  }}
                >
                  결과 문서
                </button>
              </div>
              <div data-guide="doc-download" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={downloadDocImage}
                  style={{ padding: "9px 14px", borderRadius: 9, border: "none", background: "#353433", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}
                >
                  이미지로 저장
                </button>
                <button
                  onClick={() => downloadDoc(docType)}
                  style={{ padding: "9px 14px", borderRadius: 9, border: "1px solid rgba(36,35,34,.14)", background: "#fff", color: "#242322", cursor: "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}
                >
                  HTML로 다운로드
                </button>
                <button
                  onClick={() => downloadDocMarkdown(docType)}
                  style={{ padding: "9px 14px", borderRadius: 9, border: "1px solid rgba(36,35,34,.14)", background: "#fff", color: "#242322", cursor: "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}
                >
                  마크다운으로 다운로드
                </button>
              </div>
            </div>
            <div ref={docContentRef} style={{ background: "#fff", border: "1px solid rgba(36,35,34,.1)", borderRadius: 16, padding: "34px 40px", boxShadow: "0 1px 3px rgba(0,0,0,.05)", maxWidth: 860, margin: "0 auto" }}>
            <div style={{ borderBottom: "2px solid #242322", paddingBottom: 14, marginBottom: 22 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#8a857f", letterSpacing: ".04em" }}>
                {docType === "process" ? "과정 문서 · PROCESS" : "결과 문서 · RESULT"}
              </div>
              <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-.02em", margin: "8px 0 0" }}>{selectedProject.title}</h1>
              <div style={{ fontSize: 14, color: "#8a857f", marginTop: 4 }}>
                {docType === "process" ? "회의에서 오간 모든 의견의 기록" : "득표순으로 정리된 최종 우선순위"}
              </div>
            </div>

            {/* 문서 표준 필드(목적/배경/추진 방향/기대 효과): 프로젝트당 1개, 과정/결과 공통, 인라인 편집 */}
            <DocSection title="문서 표준 정보">
              <DocTable>
                <tbody>
                  {[
                    ["목적", "purpose"],
                    ["배경", "background"],
                    ["추진 방향", "direction"],
                    ["기대 효과", "expected"],
                  ].map(([label, key]) => (
                    <tr key={key}>
                      <th style={{ border: "1px solid #e0e0e0", padding: "9px 12px", textAlign: "left", background: "#f2f2f2", width: 120, whiteSpace: "nowrap", verticalAlign: "top" }}>{label}</th>
                      <td style={{ border: "1px solid #e0e0e0", padding: "6px 12px", verticalAlign: "top" }}>
                        <textarea
                          defaultValue={board.docFields?.[key] || ""}
                          ref={(el) => autoResizeTextarea(el)}
                          onInput={(e) => autoResizeTextarea(e.target)}
                          onFocus={() => {
                            suspendPollRef.current = true;
                          }}
                          onBlur={(e) => {
                            suspendPollRef.current = false;
                            updateDocField(key, e.target.value);
                          }}
                          placeholder={`${label}을(를) 입력하세요`}
                          style={{ width: "100%", boxSizing: "border-box", border: "none", background: "transparent", resize: "none", overflow: "hidden", fontSize: 14, fontFamily: "inherit", lineHeight: 1.6, outline: "none", minHeight: 24 }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DocTable>
            </DocSection>

            {docType === "process" ? (
              <>
                <DocSection title="개요">
                  <DocTable>
                    <tbody>
                      <DocKV k="프로젝트명" v={selectedProject.title} />
                      <DocKV k="참여자 수" v={`${docModel.participants.length}명`} />
                      <DocKV k="작성된 의견 수" v={`${board.notes.length}개`} />
                      <DocKV k="문제로 표시된 의견 수" v={`${docModel.problemNotes.length}개`} />
                    </tbody>
                  </DocTable>
                </DocSection>

                <DocSection title="참여자">
                  <DocTable>
                    <thead>
                      <tr>
                        <DocTh>이름</DocTh>
                        <DocTh>배정 색상</DocTh>
                      </tr>
                    </thead>
                    <tbody>
                      {docModel.participants.length ? (
                        docModel.participants.map((p) => (
                          <tr key={p.name}>
                            <DocTd>{p.name}</DocTd>
                            <DocTd>
                              <span style={{ background: p.color.bg, color: p.color.text, border: `1px solid ${p.color.border}`, borderRadius: 6, padding: "2px 10px", fontSize: 12, fontWeight: 600 }}>
                                {p.color.name}
                              </span>
                            </DocTd>
                          </tr>
                        ))
                      ) : (
                        <DocEmpty span={2}>참여자가 없습니다.</DocEmpty>
                      )}
                    </tbody>
                  </DocTable>
                </DocSection>

                <DocSection title="의견 모음 (과정)">
                  <DocTable>
                    <thead>
                      <tr>
                        <DocTh>주제</DocTh>
                        <DocTh>내용</DocTh>
                        <DocTh>작성자</DocTh>
                      </tr>
                    </thead>
                    <tbody>
                      {board.notes.length ? (
                        docModel.notesByTopic.flatMap((t) =>
                          t.notes.map((n) => (
                            <tr key={n.id}>
                              <DocTd>{t.title}</DocTd>
                              <DocTd>
                                {n.text || <span style={{ color: "#aaa" }}>(빈 포스트잇)</span>}
                                {n.isProblem && (
                                  <span style={{ marginLeft: 6, background: "#fdecec", color: "#c0392b", border: "1px solid #eab5b0", borderRadius: 6, padding: "1px 7px", fontSize: 11, fontWeight: 600 }}>문제</span>
                                )}
                              </DocTd>
                              <DocTd>{n.authors.join(", ")}</DocTd>
                            </tr>
                          ))
                        )
                      ) : (
                        <DocEmpty span={3}>작성된 의견이 없습니다.</DocEmpty>
                      )}
                    </tbody>
                  </DocTable>
                </DocSection>

                <DocSection title="문제 정리 및 부가 설명">
                  <DocTable>
                    <thead>
                      <tr>
                        <DocTh>#</DocTh>
                        <DocTh>문제</DocTh>
                        <DocTh>작성자</DocTh>
                      </tr>
                    </thead>
                    <tbody>
                      {docModel.problemNotes.length ? (
                        docModel.problemNotes.map((n, i) => (
                          <tr key={n.id}>
                            <DocTd>{i + 1}</DocTd>
                            <DocTd>
                              {n.text}
                              {n.description && <div style={{ color: "#888", fontSize: 12.5, marginTop: 3 }}>설명: {n.description}</div>}
                            </DocTd>
                            <DocTd>{n.authors.join(", ")}</DocTd>
                          </tr>
                        ))
                      ) : (
                        <DocEmpty span={3}>문제로 표시된 의견이 없습니다.</DocEmpty>
                      )}
                    </tbody>
                  </DocTable>
                </DocSection>
              </>
            ) : (
              <>
                <DocSection title="개요">
                  <DocTable>
                    <tbody>
                      <DocKV k="프로젝트명" v={selectedProject.title} />
                      <DocKV k="문제로 표시된 의견 수" v={`${docModel.problemNotes.length}개`} />
                      <DocKV k="최다 득표" v={docModel.ranked[0] ? `${docModel.ranked[0].text} (${docModel.ranked[0].votes}표)` : "—"} />
                    </tbody>
                  </DocTable>
                </DocSection>

                <DocSection title="우선순위 TOP 5 결과">
                  <DocTable>
                    <thead>
                      <tr>
                        <DocTh>순위</DocTh>
                        <DocTh>문제</DocTh>
                        <DocTh>득표</DocTh>
                        <DocTh>투표자</DocTh>
                      </tr>
                    </thead>
                    <tbody>
                      {docModel.topRanked.length ? (
                        docModel.topRanked.map((p, i) => (
                          <tr key={p.id} style={i === 0 ? { background: "#fdf3f7" } : undefined}>
                            <DocTd>{i + 1}</DocTd>
                            <DocTd>
                              {p.text}
                              {p.description && <div style={{ color: "#888", fontSize: 12.5, marginTop: 3 }}>설명: {p.description}</div>}
                            </DocTd>
                            <DocTd>{p.votes}표</DocTd>
                            <DocTd>{p.voters.join(", ") || "—"}</DocTd>
                          </tr>
                        ))
                      ) : (
                        <DocEmpty span={4}>결과가 없습니다.</DocEmpty>
                      )}
                    </tbody>
                  </DocTable>
                </DocSection>
              </>
            )}

            {/* 우선순위 해결여부 (회고 탭 토글 ON일 때만) — 기존 콘텐츠 뒤에 배치 */}
            {docModel.priorityCheckOn && (
              <DocSection title="우선순위 해결여부">
                <DocTable>
                  <thead>
                    <tr>
                      <DocTh>#</DocTh>
                      <DocTh>문제</DocTh>
                      <DocTh>득표</DocTh>
                      <DocTh>해결여부</DocTh>
                    </tr>
                  </thead>
                  <tbody>
                    {docModel.resolutionRows.length ? (
                      docModel.resolutionRows.map((r, i) => (
                        <tr key={r.id}>
                          <DocTd>{i + 1}</DocTd>
                          <DocTd>{r.text}</DocTd>
                          <DocTd>{r.votes}표</DocTd>
                          <DocTd>{RESOLUTION_LABELS[r.resolution] || <span style={{ color: "#aaa" }}>미정</span>}</DocTd>
                        </tr>
                      ))
                    ) : (
                      <DocEmpty span={4}>우선순위로 정리된 문제가 없습니다.</DocEmpty>
                    )}
                  </tbody>
                </DocTable>
              </DocSection>
            )}

            {/* 회고(KPT) — 완료한 참여자만 누적 표시 */}
            <DocSection title="회고 (KPT)">
              {docModel.completedRetros.length ? (
                docModel.completedRetros.map((r) => (
                  <div key={r.name} style={{ marginBottom: 14 }}>
                  <DocTable>
                    <tbody>
                      <tr>
                        <th colSpan={2} style={{ border: "1px solid #e0e0e0", padding: "9px 12px", textAlign: "left", background: "#f2f2f2", fontWeight: 700 }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                            <span style={{ width: 12, height: 12, borderRadius: 999, background: r.color?.bg || "#ccc" }} />
                            {r.name}
                          </span>
                        </th>
                      </tr>
                      <tr>
                        <th style={{ border: "1px solid #e0e0e0", padding: "9px 12px", textAlign: "left", background: "#fafafa", width: 90, whiteSpace: "nowrap", verticalAlign: "top" }}>Keep</th>
                        <DocTd>{r.keep && r.keep.trim() ? r.keep : <span style={{ color: "#aaa" }}>—</span>}</DocTd>
                      </tr>
                      <tr>
                        <th style={{ border: "1px solid #e0e0e0", padding: "9px 12px", textAlign: "left", background: "#fafafa", width: 90, whiteSpace: "nowrap", verticalAlign: "top" }}>Problem</th>
                        <DocTd>{r.problem && r.problem.trim() ? r.problem : <span style={{ color: "#aaa" }}>—</span>}</DocTd>
                      </tr>
                      <tr>
                        <th style={{ border: "1px solid #e0e0e0", padding: "9px 12px", textAlign: "left", background: "#fafafa", width: 90, whiteSpace: "nowrap", verticalAlign: "top" }}>Try</th>
                        <DocTd>{r.try && r.try.trim() ? r.try : <span style={{ color: "#aaa" }}>—</span>}</DocTd>
                      </tr>
                    </tbody>
                  </DocTable>
                  </div>
                ))
              ) : (
                <div style={{ color: "#aaa", fontSize: 14 }}>완료된 회고가 없습니다.</div>
              )}
            </DocSection>

            {/* 회의 녹취록 — 회의록 녹음 내용이 있을 때만 */}
            {docModel.minutes && (
              <DocSection title="회의 녹취록">
                <div style={{ whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.7, color: "#242322" }}>{docModel.minutes}</div>
              </DocSection>
            )}
            </div>
          </motion.div>
        )}
        </AnimatePresence>
        </div>
      </div>

      <GuideCoach phase={board.phase} onGotoScreen={setPhase} />

      {/* 회의록(minutes) 패널: 헤더 "회의록 녹음"으로 열린다. 전체 회의를 누적하고 .txt·문서로 내보낸다. */}
      <AnimatePresence>
        {minutesOpen && (
          <motion.div
            key="minutes-panel"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ duration: 0.22, ease: EASE }}
            style={{
              position: "fixed",
              left: 20,
              bottom: 20,
              width: "min(440px, calc(100vw - 40px))",
              maxHeight: "min(60vh, 520px)",
              background: "#fff",
              border: "1px solid rgba(36,35,34,.12)",
              borderRadius: 16,
              boxShadow: "0 12px 40px rgba(0,0,0,.22)",
              zIndex: 200,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "14px 16px", borderBottom: "1px solid rgba(36,35,34,.08)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                {minutesRecording && <span style={{ width: 9, height: 9, borderRadius: 999, background: "#ff4242", animation: "oaRecPulse 1.1s ease-in-out infinite", flexShrink: 0 }} />}
                <span style={{ fontSize: 14, fontWeight: 700, whiteSpace: "nowrap" }}>
                  {minutesRecording ? "회의록 녹음 중 · 실시간 변환" : "회의록"}
                </span>
              </div>
              <button
                onClick={() => setMinutesOpen(false)}
                title="닫기"
                style={{ border: "none", background: "none", cursor: "pointer", color: "#a19c95", fontSize: 18, lineHeight: 1, padding: 4 }}
              >
                ×
              </button>
            </div>

            <div style={{ padding: "14px 16px", overflowY: "auto", flex: 1 }}>
              {!minutes && !minutesInterim ? (
                <div style={{ color: "#a19c95", fontSize: 13.5, lineHeight: 1.6 }}>
                  {minutesRecording
                    ? "말을 시작하면 여기에 회의 내용이 계속 쌓입니다. (온라인 회의라면 스피커 볼륨을 켜두세요)"
                    : "전체 회의 녹취록입니다. '회의록 녹음'을 눌러 시작하세요. 멈추면 문서에 자동 반영됩니다."}
                </div>
              ) : (
                <div style={{ fontSize: 14, lineHeight: 1.7, whiteSpace: "pre-wrap", color: "#242322" }}>
                  {minutes}
                  {minutesInterim && <span style={{ color: "#a19c95" }}>{minutes ? " " : ""}{minutesInterim}</span>}
                </div>
              )}
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "12px 16px", borderTop: "1px solid rgba(36,35,34,.08)", background: "#faf9f7" }}>
              <div style={{ width: "100%", fontSize: 12, lineHeight: 1.5, color: "#a19c95" }}>
                녹음을 멈추면 전체 회의록이 문서 탭의 "회의 녹취록"에 자동 반영됩니다. "중복 정리"는 반복된 문장·단어만 걷어냅니다(요약 아님).
              </div>
              <button
                onClick={toggleRecord}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 13px", borderRadius: 8, border: `1px solid ${minutesRecording ? "#ffcaca" : "rgba(36,35,34,.14)"}`, background: minutesRecording ? "#fdeaea" : "#fff", color: minutesRecording ? "#d32f2f" : "#242322", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
              >
                <span style={{ width: 8, height: 8, borderRadius: 999, background: "#ff4242", animation: minutesRecording ? "oaRecPulse 1.1s ease-in-out infinite" : "none" }} />
                {minutesRecording ? "녹음 중지" : minutes ? "이어서 녹음" : "회의록 녹음"}
              </button>
              <button
                onClick={cleanupMinutes}
                disabled={!minutes || minutesRecording}
                title="반복된 문장·단어를 제거합니다(요약은 아님)"
                style={{ padding: "8px 13px", borderRadius: 8, border: "1px solid rgba(36,35,34,.14)", background: "#fff", color: minutes && !minutesRecording ? "#242322" : "#c4bfb8", cursor: minutes && !minutesRecording ? "pointer" : "not-allowed", fontSize: 13, fontWeight: 600 }}
              >
                중복 정리
              </button>
              <button
                onClick={copyMinutes}
                disabled={!minutes}
                style={{ padding: "8px 13px", borderRadius: 8, border: "1px solid rgba(36,35,34,.14)", background: "#fff", color: minutes ? "#242322" : "#c4bfb8", cursor: minutes ? "pointer" : "not-allowed", fontSize: 13, fontWeight: 600 }}
              >
                복사
              </button>
              <button
                onClick={downloadMinutes}
                disabled={!minutes}
                style={{ padding: "8px 13px", borderRadius: 8, border: "none", background: minutes ? "#242322" : "#f0ede8", color: minutes ? "#fff" : "#c4bfb8", cursor: minutes ? "pointer" : "not-allowed", fontSize: 13, fontWeight: 600 }}
              >
                .txt 다운로드
              </button>
              <button
                onClick={clearMinutes}
                disabled={!minutes || minutesRecording}
                style={{ marginLeft: "auto", padding: "8px 13px", borderRadius: 8, border: "none", background: "none", color: minutes && !minutesRecording ? "#a19c95" : "#d5d1cb", cursor: minutes && !minutesRecording ? "pointer" : "not-allowed", fontSize: 13, fontWeight: 600 }}
              >
                내용 지우기
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <ConfirmDialog
        open={!!confirmState}
        title={confirmState?.title}
        message={confirmState?.message}
        confirmLabel={confirmState?.confirmLabel}
        onConfirm={confirmState?.onConfirm}
        onCancel={() => setConfirmState(null)}
      />
    </div>
  );
}

// ---- 문서 뷰용 표 컴포넌트 (앱 내 표시용) ----
function DocSection({ title, children }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ fontSize: 16, fontWeight: 700, margin: "0 0 10px", paddingBottom: 6, borderBottom: "2px solid #eee" }}>{title}</div>
      {children}
    </div>
  );
}
function DocTable({ children }) {
  return <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>{children}</table>;
}
function DocTh({ children }) {
  return <th style={{ border: "1px solid #e0e0e0", padding: "9px 12px", textAlign: "left", background: "#e9e9e9", fontWeight: 700 }}>{children}</th>;
}
function DocTd({ children }) {
  return <td style={{ border: "1px solid #e0e0e0", padding: "9px 12px", textAlign: "left", verticalAlign: "top" }}>{children}</td>;
}
function DocKV({ k, v }) {
  return (
    <tr>
      <th style={{ border: "1px solid #e0e0e0", padding: "9px 12px", textAlign: "left", background: "#f2f2f2", width: 160, whiteSpace: "nowrap" }}>{k}</th>
      <DocTd>{v}</DocTd>
    </tr>
  );
}
function DocEmpty({ span, children }) {
  return (
    <tr>
      <td colSpan={span} style={{ border: "1px solid #e0e0e0", padding: "9px 12px", color: "#aaa" }}>
        {children}
      </td>
    </tr>
  );
}

"use strict";

const fmtUsd = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = (n) => n.toLocaleString("en-US");
const fmtCompact = (n) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

let DATA = null;
let scope = "user";

function showTab(tab) {
  const overview = tab !== "ranking";
  document.getElementById("panel-overview").classList.toggle("hidden", !overview);
  document.getElementById("panel-ranking").classList.toggle("hidden", overview);
  document.getElementById("tab-overview").classList.toggle("active", overview);
  document.getElementById("tab-ranking").classList.toggle("active", !overview);
  document.querySelectorAll(".side nav a").forEach((a, i) => a.classList.toggle("active", i === (overview ? 0 : 1)));
}
window.showTab = showTab;

function setScope(s) {
  scope = s;
  document.getElementById("seg-user").classList.toggle("active", s === "user");
  document.getElementById("seg-team").classList.toggle("active", s === "team");
  const label = s === "team" ? "팀" : "개인";
  document.getElementById("rank-title").textContent = `비용 상위 ${label}`;
  document.getElementById("rank-table-title").textContent = `${label} 순위`;
  document.getElementById("rank-col").textContent = label;
  renderRanking();
}
window.setScope = setScope;

function dayLabel(offset) {
  const d = new Date(Date.now() - offset * 86400000);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function areaChart(daily) {
  const pts = [...daily].sort((a, b) => b.dayOffset - a.dayOffset); // 오래된→최신
  const W = 640, H = 220, L = 48, R = 16, T = 16, B = 30;
  const plotW = W - L - R, plotH = H - T - B;
  const max = Math.max(...pts.map((p) => p.costUsd)) * 1.15 || 1;
  const x = (i) => L + (pts.length === 1 ? plotW / 2 : (plotW * i) / (pts.length - 1));
  const y = (v) => T + plotH - (plotH * v) / max;

  let grid = "";
  for (let g = 0; g <= 2; g++) {
    const gv = (max / 2) * g;
    const gy = y(gv);
    grid += `<line x1="${L}" y1="${gy}" x2="${W - R}" y2="${gy}" stroke="var(--border)" stroke-width="1"/>`;
    grid += `<text class="axis" x="${L - 8}" y="${gy + 4}" text-anchor="end">$${gv.toFixed(1)}</text>`;
  }
  const line = pts.map((p, i) => `${x(i)},${y(p.costUsd)}`).join(" ");
  const area = `M ${x(0)},${T + plotH} ` + pts.map((p, i) => `L ${x(i)},${y(p.costUsd)}`).join(" ") + ` L ${x(pts.length - 1)},${T + plotH} Z`;
  const dots = pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.costUsd)}" r="3.5" style="fill:var(--accent)"/>`).join("");
  const xlabels = pts.map((p, i) => `<text class="axis" x="${x(i)}" y="${H - 10}" text-anchor="middle">${dayLabel(p.dayOffset)}</text>`).join("");

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="일별 비용 추이">
    ${grid}
    <path d="${area}" style="fill:var(--accent)" fill-opacity="0.13"/>
    <polyline points="${line}" fill="none" style="stroke:var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}${xlabels}
  </svg>`;
}

function barChart(rows) {
  const W = 640, rowH = 46, padT = 8, labelW = 92, valW = 76;
  const H = rows.length * rowH + padT;
  const trackX = labelW, trackR = W - valW;
  const trackW = trackR - trackX;
  const max = Math.max(...rows.map((r) => r.costUsd)) || 1;
  let out = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="비용 상위 순위">`;
  rows.forEach((r, i) => {
    const cy = padT + i * rowH + rowH / 2;
    const bw = Math.max(3, (trackW * r.costUsd) / max);
    const strong = i === 0;
    out += `<text class="axis" x="0" y="${cy + 4}" style="fill:var(--text)" font-size="13">${esc(r.label)}</text>`;
    out += `<rect x="${trackX}" y="${cy - 11}" width="${trackW}" height="22" rx="5" fill="var(--surface-2)"/>`;
    out += `<rect x="${trackX}" y="${cy - 11}" width="${bw}" height="22" rx="5" style="fill:var(--accent)" fill-opacity="${strong ? 1 : 0.55}"/>`;
    out += `<text class="axis" x="${W}" y="${cy + 4}" text-anchor="end" style="fill:var(--text)" font-size="13">${fmtUsd(r.costUsd)}</text>`;
  });
  out += `</svg>`;
  return out;
}

function renderOverview() {
  const o = DATA.overview;
  document.getElementById("s-cost").textContent = fmtUsd(o.totalCostUsd);
  document.getElementById("s-sessions").textContent = fmtNum(o.totalSessions);
  document.getElementById("s-users").textContent = fmtNum(o.activeUsers);
  document.getElementById("s-tokens").textContent = fmtCompact(o.totalInputTokens + o.totalOutputTokens);
  document.getElementById("s-tokens-hint").textContent = `입력 ${fmtCompact(o.totalInputTokens)} · 출력 ${fmtCompact(o.totalOutputTokens)}`;

  document.getElementById("c-daily").innerHTML = areaChart(DATA.daily);

  document.getElementById("t-top").innerHTML = DATA.leaderboardUser
    .slice(0, 6)
    .map((r) => `<tr><td class="name">${esc(r.label)}</td><td class="num">${fmtUsd(r.costUsd)}</td></tr>`)
    .join("");

  document.getElementById("t-model").innerHTML = DATA.byModel
    .map((m) => `<tr><td class="name">${esc(m.model)}</td><td class="num">${fmtNum(m.sessions)}</td><td class="num">${fmtCompact(m.totalTokens)}</td><td class="num">${fmtUsd(m.costUsd)}</td></tr>`)
    .join("");
}

function renderRanking() {
  const rows = scope === "team" ? DATA.leaderboardTeam : DATA.leaderboardUser;
  document.getElementById("c-rank").innerHTML = barChart(rows);
  document.getElementById("t-rank").innerHTML = rows
    .map((r, i) => `<tr><td class="rank">${i + 1}</td><td class="name">${esc(r.label)}</td><td class="num">${fmtNum(r.sessions)}</td><td class="num">${fmtCompact(r.totalTokens)}</td><td class="num">${fmtUsd(r.costUsd)}</td></tr>`)
    .join("");
}

fetch("demo-data.json")
  .then((r) => {
    if (!r.ok) throw new Error(`demo-data.json ${r.status}`);
    return r.json();
  })
  .then((d) => {
    DATA = d;
    renderOverview();
    renderRanking();
  })
  .catch((e) => {
    document.querySelector(".main").insertAdjacentHTML(
      "afterbegin",
      `<div class="demo-banner" style="color:#a32d2d;background:#fcebeb">데모 데이터를 불러오지 못했습니다: ${esc(e.message)}</div>`,
    );
  });

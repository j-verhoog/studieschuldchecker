const defaults = {
  debt: 35000,
  income: 42000,
  partnerIncome: 0,
  household: "single",
  graduationDate: "2026-06-10",
  interest: 2.33,
  fixedYears: 5,
  incomeGrowth: 3.0,
  exemptionGrowth: 2.5,
  futureInterest: 2.33,
  extraPayment: 0,
  pauseStrategy: "immediate",
  pauseMonths: 60,
  customPauseStartYear: 10,
  minPaymentThreshold: 5,
  incomeLag: true,
  roundDown: true
};

let state = { ...defaults };
let lastSimulation = null;

const el = id => document.getElementById(id);
const money = value => new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value || 0);
const fmtDate = date => date.toLocaleDateString("nl-NL", { year: "numeric", month: "short", day: "numeric" });
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function readInputValue(input) {
  if (input.type === "checkbox") return input.checked;
  if (input.type === "number") return Number(input.value || 0);
  return input.value;
}

function setupChartInteractions(canvasEl, data, annualRows, params) {
  const canvas = canvasEl;
  if (!canvas) return;
  // create tooltip element once
  if (!canvas._chartTooltipDiv) {
    const div = document.createElement('div');
    div.className = 'chart-tooltip';
    div.style.display = 'none';
    document.body.appendChild(div);
    canvas._chartTooltipDiv = div;
  }

  // update stored data reference
  canvas._chartDataRef = { data, annualRows, params };

  if (canvas._chartHandlersAttached) return;

  canvas.addEventListener('mousemove', e => {
    const ref = canvas._chartDataRef || { data, annualRows, params };
    const rows = ref.data || [];
    if (!rows.length) return;
    const rect = canvas.getBoundingClientRect();
    const pad = { left: 70, right: 24, top: 28, bottom: 48 };
    const plotW = rect.width - pad.left - pad.right;
    const mouseX = e.clientX - rect.left;
    const t = Math.max(0, Math.min(1, (mouseX - pad.left) / Math.max(1, plotW)));
    const idx = Math.round(t * Math.max(1, rows.length - 1));
    drawChart(rows, ref.annualRows || [], ref.params || state, idx);

    const year = Math.min(35, Math.floor(idx / 12) + 1);
    const ar = (ref.annualRows && ref.annualRows[year - 1]) || null;
    const calendarYear = ar && ar.calendarYear ? ar.calendarYear : getRepaymentStart(ref.params.graduationDate).getFullYear() + (year - 1);
    const income = ar ? ar.income : incomeForRepaymentYear(ref.params, year - 1);
    const exemption = ar ? ar.exemption : exemptionForRepaymentYear(ref.params, year - 1);
    let capacity = ar ? ar.capacity : Math.max(0, (income - exemption) * 0.04 / 12);
    if (capacity < (ref.params ? ref.params.minPaymentThreshold : state.minPaymentThreshold)) capacity = 0;
    if (ref.params && ref.params.roundDown) capacity = Math.floor(capacity);
    const paid = ar ? ar.paid : null;
    const balance = ar ? ar.balance : null;

    const tooltip = canvas._chartTooltipDiv;
    tooltip.innerHTML = `
      <div class="title">Jaar ${year} — ${calendarYear}</div>
      <div class="line"><span class="muted">Inkomen</span><strong>${money(income)}</strong></div>
      <div class="line"><span class="muted">Vrijstelling</span><strong>${money(exemption)}</strong></div>
      <div class="line"><span class="muted">Draagkracht p/m</span><strong>${money(capacity)}</strong></div>
      <div class="line"><span class="muted">Betaald (jaar)</span><strong>${paid != null ? money(paid) : '—'}</strong></div>
      <div class="line"><span class="muted">Schuld einde jaar</span><strong>${balance != null ? money(balance) : '—'}</strong></div>
    `;

    // position tooltip near cursor, but keep inside viewport
    const padEdge = 12;
    let left = e.clientX + 12;
    let top = e.clientY + 12;
    const tw = tooltip.offsetWidth || 200;
    const th = tooltip.offsetHeight || 140;
    if (left + tw + padEdge > window.innerWidth) left = e.clientX - tw - 12;
    if (top + th + padEdge > window.innerHeight) top = e.clientY - th - 12;
    tooltip.style.left = `${Math.max(padEdge, left)}px`;
    tooltip.style.top = `${Math.max(padEdge, top)}px`;
    tooltip.style.display = 'block';
  });

  canvas.addEventListener('mouseleave', () => {
    const ref = canvas._chartDataRef || { data, annualRows, params };
    drawChart(ref.data || [], ref.annualRows || [], ref.params || state, null);
    if (canvas._chartTooltipDiv) canvas._chartTooltipDiv.style.display = 'none';
  });

  canvas._chartHandlersAttached = true;
}

function writeInputValue(input, value) {
  if (input.type === "checkbox") input.checked = Boolean(value);
  else input.value = value;
}

function extractInputs() {
  const next = { ...state };
  Object.keys(defaults).forEach(key => {
    const input = el(key);
    if (input) next[key] = readInputValue(input);
  });

  next.debt = Math.max(0, next.debt);
  next.income = Math.max(0, next.income);
  next.partnerIncome = Math.max(0, next.partnerIncome);
  next.interest = clamp(next.interest, 0, 20);
  next.futureInterest = clamp(next.futureInterest, 0, 20);
  next.fixedYears = clamp(Math.round(next.fixedYears), 1, 35);
  next.incomeGrowth = next.incomeGrowth / 100;
  next.exemptionGrowth = next.exemptionGrowth / 100;
  next.extraPayment = Math.max(0, next.extraPayment);
  next.pauseMonths = clamp(Math.round(next.pauseMonths), 0, 60);
  next.customPauseStartYear = clamp(Math.round(next.customPauseStartYear), 1, 35);
  next.minPaymentThreshold = Math.max(0, next.minPaymentThreshold);
  return next;
}

function monthlyRate(annualPercent) {
  return Math.pow(1 + annualPercent / 100, 1 / 12) - 1;
}

function annuity(balance, rate, months) {
  if (balance <= 0 || months <= 0) return 0;
  if (rate === 0) return balance / months;
  return balance * rate / (1 - Math.pow(1 + rate, -months));
}

function parseLocalDate(value) {
  const [year, month, day] = String(value || defaults.graduationDate).split("-").map(Number);
  return new Date(year, month - 1, day);
}

function addMonths(date, months) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

function addYears(date, years) {
  const next = new Date(date);
  next.setFullYear(next.getFullYear() + years);
  return next;
}

function firstJanuaryOnOrAfter(date) {
  if (date.getMonth() === 0 && date.getDate() === 1) return new Date(date.getFullYear(), 0, 1);
  return new Date(date.getFullYear() + 1, 0, 1);
}

function getRepaymentStart(graduationDate) {
  return firstJanuaryOnOrAfter(addYears(parseLocalDate(graduationDate), 2));
}

function createPausePlan(params) {
  const months = params.pauseStrategy === "none" ? 0 : clamp(Math.round(params.pauseMonths), 0, 60);
  if (months <= 0) return { months: 0, startMonth: null, endMonth: null, pausedMonths: new Set() };

  let startMonth;
  if (params.pauseStrategy === "immediate") startMonth = 1;
  else if (params.pauseStrategy === "middle") startMonth = Math.floor((420 - months) / 2) + 1;
  else if (params.pauseStrategy === "final") startMonth = 420 - months + 1;
  else startMonth = (params.customPauseStartYear - 1) * 12 + 1;

  startMonth = clamp(startMonth, 1, 420);
  const pausedMonths = new Set();
  for (let i = 0; i < months; i++) pausedMonths.add(startMonth + i);

  return {
    months,
    startMonth,
    endMonth: startMonth + months - 1,
    pausedMonths
  };
}

function describePausePlan(plan, repaymentStart) {
  if (!plan.months) return "Geen";
  const start = addMonths(repaymentStart, plan.startMonth - 1);
  const end = addMonths(repaymentStart, plan.endMonth - 1);
  return `${plan.months} maanden, ${fmtDate(start)} t/m ${fmtDate(end)}`;
}

function incomeForRepaymentYear(params, repaymentYearIndex) {
  const growthIndex = params.incomeLag ? Math.max(0, repaymentYearIndex - 2) : repaymentYearIndex;
  return (params.income + params.partnerIncome) * Math.pow(1 + params.incomeGrowth, growthIndex);
}

function exemptionForRepaymentYear(params, repaymentYearIndex) {
  const baseExemption = params.household === "single" ? 26819.42 : 38351.77;
  return baseExemption * Math.pow(1 + params.exemptionGrowth, repaymentYearIndex);
}

function getPhase(isPaused, activeRepaymentMonthsDone) {
  if (isPaused) return "Aflosvrij";
  if (activeRepaymentMonthsDone < 420) return "Aflossen";
  return "Na looptijd";
}

function simulateDebtTrajectory(params) {
  const repaymentStart = getRepaymentStart(params.graduationDate);
  const pausePlan = createPausePlan(params);
  const pauseSet = pausePlan.pausedMonths;
  const maxTimelineMonths = 420 + pausePlan.months;
  const rows = [];
  const annualRows = [];

  let balance = params.debt;
  let totalPaid = 0;
  let paidOffMonth = null;
  let maxPayment = 0;
  let activeRepaymentMonthsDone = 0;
  let locked = { capacity: 0, standardPayment: 0, requiredPayment: 0, income: params.income + params.partnerIncome, exemption: 0 };

  for (let timelineMonth = 1; timelineMonth <= maxTimelineMonths; timelineMonth++) {
    const date = addMonths(repaymentStart, timelineMonth - 1);
    const repaymentYearIndex = Math.floor((timelineMonth - 1) / 12);
    const annualInterest = timelineMonth <= params.fixedYears * 12 ? params.interest : params.futureInterest;
    const rate = monthlyRate(annualInterest);
    const activeMonthNumber = activeRepaymentMonthsDone + 1;
    const isPaused = pauseSet.has(timelineMonth);

    if ((timelineMonth - 1) % 12 === 0) {
      const income = incomeForRepaymentYear(params, repaymentYearIndex);
      const exemption = exemptionForRepaymentYear(params, repaymentYearIndex);
      const annualCapacity = Math.max(0, (income - exemption) * 0.04);
      let capacity = annualCapacity / 12;
      if (capacity < params.minPaymentThreshold) capacity = 0;
      if (params.roundDown) capacity = Math.floor(capacity);

      const remainingActiveMonths = Math.max(1, 420 - activeRepaymentMonthsDone);
      let standardPayment = annuity(balance, rate, remainingActiveMonths);
      if (params.roundDown) standardPayment = Math.floor(standardPayment);
      const requiredPayment = Math.min(capacity, standardPayment);
      locked = { capacity, standardPayment, requiredPayment, income, exemption };
    }

    const balanceBeforeInterest = balance;
    const interestAdded = balanceBeforeInterest * rate;
    balance += interestAdded;

    let required = isPaused ? 0 : locked.requiredPayment;
    if (balance <= 0) required = 0;
    const payment = Math.min(balance, required + (isPaused ? 0 : params.extraPayment));
    balance = Math.max(0, balance - payment);
    totalPaid += payment;
    maxPayment = Math.max(maxPayment, payment);

    if (!isPaused) activeRepaymentMonthsDone += 1;
    if (!paidOffMonth && balance <= 0.01) paidOffMonth = timelineMonth;

    rows.push({
      timelineMonth,
      date,
      calendarYear: date.getFullYear(),
      repaymentYear: repaymentYearIndex + 1,
      activeRepaymentMonthsDone,
      activeMonthNumber,
      phase: getPhase(isPaused, activeRepaymentMonthsDone),
      isPaused,
      balance,
      payment,
      capacity: locked.capacity,
      standardPayment: locked.standardPayment,
      requiredPayment: locked.requiredPayment,
      income: locked.income,
      exemption: locked.exemption,
      interestAdded
    });

    if (timelineMonth % 12 === 0 || timelineMonth === maxTimelineMonths || balance <= 0) {
      const yearRows = rows.filter(row => row.repaymentYear === repaymentYearIndex + 1);
      const phase = yearRows.every(row => row.isPaused) ? "Aflosvrij" : yearRows.some(row => row.isPaused) ? "Gemengd" : "Aflossen";
      annualRows.push({
        year: repaymentYearIndex + 1,
        calendarYear: date.getFullYear(),
        phase,
        income: locked.income,
        exemption: locked.exemption,
        capacity: locked.capacity,
        standardPayment: locked.standardPayment,
        paid: yearRows.reduce((sum, row) => sum + row.payment, 0),
        balance
      });
    }

    if (balance <= 0.01 || activeRepaymentMonthsDone >= 420) break;
  }

  const firstRequired = rows.find(row => row.payment > 0) || rows.find(row => !row.isPaused) || rows[0];
  const forgiven = balance > 0 ? balance : 0;
  const avgPayment = rows.length ? totalPaid / rows.length : 0;
  const simulationEnd = rows.length ? rows[rows.length - 1].date : repaymentStart;

  return {
    params,
    repaymentStart,
    rows,
    annualRows,
    firstRequired,
    totalPaid,
    paidOffMonth,
    maxPayment,
    forgiven,
    avgPayment,
    simulationEnd,
    pauseMonthsUsed: pausePlan.months,
    pausePlan
  };
}

function updateUI(result) {
  const firstPayment = result.firstRequired ? result.firstRequired.payment : 0;
  el("heroPayment").textContent = money(firstPayment);
  el("firstPayment").textContent = money(firstPayment);
  el("avgPayment").textContent = money(result.avgPayment);
  el("totalPaid").textContent = money(result.totalPaid);
  el("forgiven").textContent = money(result.forgiven);
  el("paidOffMonth").textContent = result.paidOffMonth ? `Maand ${result.paidOffMonth}` : "Niet binnen periode";
  el("maxPayment").textContent = money(result.maxPayment);
  el("repaymentStart").textContent = fmtDate(result.repaymentStart);
  el("simulationEnd").textContent = fmtDate(result.simulationEnd);
  el("pauseSummary").textContent = describePausePlan(result.pausePlan, result.repaymentStart);
  el("chartSummary").textContent = `De simulatie start op ${fmtDate(result.repaymentStart)}. Het eerste verplichte maandbedrag is ${money(firstPayment)}, totaal betaald is ${money(result.totalPaid)} en de resterende kwijtschelding is ${money(result.forgiven)}.`;

  renderTable(result.annualRows);
  drawChart(result.rows, result.annualRows, result.params);
  setupChartInteractions(el('chart'), result.rows, result.annualRows, result.params);
}

function renderTable(rows) {
  el("yearRows").innerHTML = rows.map(row => `
    <tr>
      <td>${row.year}</td>
      <td>${row.calendarYear}</td>
      <td>${row.phase}</td>
      <td>${money(row.income)}</td>
      <td>${money(row.exemption)}</td>
      <td>${money(row.capacity)}</td>
      <td>${money(row.standardPayment)}</td>
      <td>${money(row.paid)}</td>
      <td>${money(row.balance)}</td>
    </tr>
  `).join("");
}

function setupCanvas(canvas) {
  const wrap = canvas.parentElement;
  const rect = wrap.getBoundingClientRect();
  const cssWidth = Math.max(320, rect.width - 24);
  const cssHeight = 360;
  const ratio = window.devicePixelRatio || 1;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  canvas.width = Math.round(cssWidth * ratio);
  canvas.height = Math.round(cssHeight * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width: cssWidth, height: cssHeight };
}

function drawChart(data, annualRows = [], params = state, highlightIndex = null) {
  const canvas = el("chart");
  const { ctx, width: w, height: h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  // ensure a solid white background so the canvas isn't visually empty
  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
  ctx.font = "14px system-ui";
  ctx.lineWidth = 2;

  if (!data.length) return;

  const pad = { left: 70, right: 24, top: 28, bottom: 48 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;
  const maxBalance = Math.max(...data.map(d => d.balance), params.debt, 1);
  const maxPayment = Math.max(...data.map(d => d.payment), 1);

  ctx.strokeStyle = "#dce3ee";
  ctx.beginPath();
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + plotH * i / 4;
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
  }
  ctx.stroke();

  ctx.fillStyle = "#637083";
  ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const value = maxBalance * (1 - i / 4);
    const y = pad.top + plotH * i / 4 + 5;
    ctx.fillText(money(value), pad.left - 10, y);
  }

  const x = index => pad.left + plotW * index / Math.max(1, data.length - 1);
  const yBalance = value => pad.top + plotH * (1 - value / maxBalance);
  const yPayment = value => pad.top + plotH * (1 - value / maxPayment);

  // Debt line
  ctx.strokeStyle = "#215cff";
  ctx.beginPath();
  data.forEach((d, i) => {
    const px = x(i);
    const py = yBalance(d.balance);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  // Payment line
  ctx.strokeStyle = "#0f7a4f";
  ctx.beginPath();
  data.forEach((d, i) => {
    const px = x(i);
    const py = yPayment(d.payment);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  // Yearly salary series (35 points)
  const yearSeries = [];
  for (let y = 1; y <= 35; y++) {
    const index = Math.min(data.length - 1, (y - 1) * 12);
    const income = incomeForRepaymentYear(params, y - 1);
    yearSeries.push({ year: y, index, income });
  }
  const maxIncome = Math.max(...yearSeries.map(y => y.income), 1);
  const yIncome = value => pad.top + plotH * (1 - value / maxIncome);

  ctx.strokeStyle = "#ad5f00";
  ctx.beginPath();
  yearSeries.forEach((p, i) => {
    const px = x(p.index);
    const py = yIncome(p.income);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  // Right axis for income
  ctx.fillStyle = "#637083";
  ctx.textAlign = "left";
  for (let i = 0; i <= 4; i++) {
    const value = maxIncome * (1 - i / 4);
    const y = pad.top + plotH * i / 4 + 5;
    ctx.fillText(money(value), w - pad.right + 8, y);
  }

  // Legend
  ctx.fillStyle = "#172033";
  ctx.textAlign = "left";
  ctx.fillText("Schuld", pad.left, 20);
  ctx.fillStyle = "#0f7a4f";
  ctx.fillText("Maandbetaling", pad.left + 80, 20);
  ctx.fillStyle = "#ad5f00";
  ctx.fillText("Salaris", pad.left + 180, 20);

  ctx.fillStyle = "#637083";
  ctx.textAlign = "center";
  ctx.fillText("Maanden na start aflosfase", pad.left + plotW / 2, h - 12);

  // Highlight vertical line and markers
  if (typeof highlightIndex === 'number') {
    const px = x(highlightIndex);
    ctx.save();
    ctx.strokeStyle = "rgba(23,32,51,0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, pad.top);
    ctx.lineTo(px, h - pad.bottom);
    ctx.stroke();

    const row = data[Math.min(highlightIndex, data.length - 1)];
    if (row) {
      const pb = yBalance(row.balance);
      ctx.beginPath(); ctx.fillStyle = '#215cff'; ctx.arc(px, pb, 4, 0, Math.PI * 2); ctx.fill();
      const pp = yPayment(row.payment);
      ctx.beginPath(); ctx.fillStyle = '#0f7a4f'; ctx.arc(px, pp, 4, 0, Math.PI * 2); ctx.fill();
    }

    const yearIdx = Math.floor(highlightIndex / 12);
    const incomeVal = incomeForRepaymentYear(params, yearIdx);
    const pi = yIncome(incomeVal);
    ctx.beginPath(); ctx.fillStyle = '#ad5f00'; ctx.arc(px, pi, 4, 0, Math.PI * 2); ctx.fill();

    ctx.restore();
  }
}

// Tooltip portal implementation: clones tooltip content into a body-level portal
let tooltipPortal = null;
let portalState = { visible: false, pinnedTrigger: null, lastTrigger: null, hideTimer: null };
let tooltipPortalCounter = 0;

function ensureTooltipPortal() {
  if (tooltipPortal) return tooltipPortal;
  tooltipPortal = document.createElement("div");
  tooltipPortal.className = "tooltip-portal";
  tooltipPortal.setAttribute("aria-hidden", "true");
  document.body.appendChild(tooltipPortal);
  return tooltipPortal;
}

function positionPortalFor(button, portalContent) {
  const portal = ensureTooltipPortal();
  const rect = button.getBoundingClientRect();
  const pcRect = portalContent.getBoundingClientRect();
  const scrollX = window.scrollX || window.pageXOffset || 0;
  const scrollY = window.scrollY || window.pageYOffset || 0;
  let left = rect.left + scrollX + rect.width / 2 - pcRect.width / 2;
  let top = rect.top + scrollY - pcRect.height - 10;
  if (top < scrollY + 8) top = rect.bottom + scrollY + 10;
  const minLeft = scrollX + 8;
  const maxLeft = scrollX + (window.innerWidth || document.documentElement.clientWidth) - pcRect.width - 8;
  left = Math.max(minLeft, Math.min(left, maxLeft));
  portal.style.left = `${Math.round(left)}px`;
  portal.style.top = `${Math.round(top)}px`;
}

function showPortal(triggerWrapper, contentEl, { pinned = false } = {}) {
  const portal = ensureTooltipPortal();
  // clear any scheduled hide so the portal doesn't immediately disappear
  if (portalState.hideTimer) { clearTimeout(portalState.hideTimer); portalState.hideTimer = null; }
  portal.innerHTML = "";
  const portalContent = document.createElement("div");
  portalContent.className = "tooltip-portal-content";
  portalContent.innerHTML = contentEl.innerHTML;
  // accessibility: give the portal content a role and an id, make it focusable
  portalContent.setAttribute('role', 'tooltip');
  portalContent.tabIndex = -1;
  const newId = `tooltip-portal-${++tooltipPortalCounter}`;
  portalContent.id = newId;
  portal.appendChild(portalContent);
  portal.setAttribute("aria-hidden", "false");
  portalState.visible = true;
  portalState.lastTrigger = triggerWrapper;
  portalState.pinnedTrigger = pinned ? triggerWrapper : null;

  const btn = triggerWrapper.querySelector('.info-button');
  // store/replace aria-describedby on the trigger button so screen readers point to portal
  portalState.previousAriaDescribedBy = btn ? btn.getAttribute('aria-describedby') : null;
  if (btn) {
    btn.setAttribute('aria-expanded', 'true');
    btn.setAttribute('aria-describedby', portalContent.id);
    portalState.triggerButton = btn;
  }

  positionPortalFor(triggerWrapper.querySelector('.info-button'), portalContent);

  portal.style.pointerEvents = 'auto';

  document.addEventListener('mousedown', onDocMouseDown);
  document.addEventListener('keydown', onDocKeyDown);
  window.addEventListener('resize', onWindowChange);
  window.addEventListener('scroll', onWindowChange, true);

  portalContent.addEventListener('click', e => e.stopPropagation());
  // keep portal open while pointer is inside it
  portalContent.addEventListener('mouseenter', () => {
    if (portalState.hideTimer) { clearTimeout(portalState.hideTimer); portalState.hideTimer = null; }
  });
  portalContent.addEventListener('mouseleave', () => {
    if (portalState.pinnedTrigger === triggerWrapper) return;
    portalState.hideTimer = setTimeout(() => hidePortal(), 120);
  });
}

function hidePortal() {
  if (!tooltipPortal) return;
  if (portalState.hideTimer) { clearTimeout(portalState.hideTimer); portalState.hideTimer = null; }
  tooltipPortal.innerHTML = '';
  tooltipPortal.setAttribute('aria-hidden', 'true');
  portalState.visible = false;
  portalState.pinnedTrigger = null;
  portalState.lastTrigger = null;
  portalState.hideTimer = null;

  // restore aria attributes on trigger button
  if (portalState.triggerButton) {
    try {
      portalState.triggerButton.setAttribute('aria-expanded', 'false');
      if (portalState.previousAriaDescribedBy) portalState.triggerButton.setAttribute('aria-describedby', portalState.previousAriaDescribedBy);
      else portalState.triggerButton.removeAttribute('aria-describedby');
    } catch (e) {}
    portalState.triggerButton = null;
    portalState.previousAriaDescribedBy = null;
  }

  document.removeEventListener('mousedown', onDocMouseDown);
  document.removeEventListener('keydown', onDocKeyDown);
  window.removeEventListener('resize', onWindowChange);
  window.removeEventListener('scroll', onWindowChange, true);
}

function onDocMouseDown(e) {
  if (!tooltipPortal) return;
  if (tooltipPortal.contains(e.target)) return;
  hidePortal();
}

function onDocKeyDown(e) {
  if (e.key === 'Escape' || e.key === 'Esc') hidePortal();
}

function onWindowChange() {
  if (!portalState.visible || !tooltipPortal || !tooltipPortal.firstElementChild) return;
  const trigger = portalState.pinnedTrigger || portalState.lastTrigger;
  if (!trigger) return;
  positionPortalFor(trigger.querySelector('.info-button'), tooltipPortal.firstElementChild);
}

function attachTooltipHandlers() {
  ensureTooltipPortal();
  // signal CSS to hide inline tooltips when JS portal is active
  document.documentElement.classList.add('js-tooltip-portal');
  document.querySelectorAll('.tooltip').forEach(wrapper => {
    const button = wrapper.querySelector('.info-button');
    const content = wrapper.querySelector('.tooltip-content');
    if (!button || !content) return;

    let enterTimer = null;

    button.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      if (portalState.pinnedTrigger === wrapper) hidePortal();
      else showPortal(wrapper, content, { pinned: true });
    });

    wrapper.addEventListener('mouseenter', () => {
      if (portalState.hideTimer) { clearTimeout(portalState.hideTimer); portalState.hideTimer = null; }
      if (portalState.pinnedTrigger === wrapper) return;
      if (enterTimer) clearTimeout(enterTimer);
      enterTimer = setTimeout(() => showPortal(wrapper, content, { pinned: false }), 60);
    });

    wrapper.addEventListener('mouseleave', () => {
      if (enterTimer) { clearTimeout(enterTimer); enterTimer = null; }
      if (portalState.pinnedTrigger === wrapper) return;
      portalState.hideTimer = setTimeout(() => hidePortal(), 120);
    });

    button.addEventListener('focus', () => showPortal(wrapper, content, { pinned: false }));
    button.addEventListener('blur', () => {
      if (portalState.pinnedTrigger === wrapper) return;
      setTimeout(() => { if (!tooltipPortal.contains(document.activeElement)) hidePortal(); }, 50);
    });
  });
}

function calculate() {
  state = extractInputs();
  lastSimulation = simulateDebtTrajectory(state);
  updateUI(lastSimulation);
}

function resetDefaults() {
  state = { ...defaults };
  Object.entries(defaults).forEach(([key, value]) => {
    const input = el(key);
    if (input) writeInputValue(input, value);
  });
  calculate();
}

function init() {
  // Attach enhanced tooltip handlers (hover + click-to-pin, portal)
  attachTooltipHandlers();

  Object.keys(defaults).forEach(key => {
    const input = el(key);
    if (!input) return;
    input.addEventListener("input", calculate);
    input.addEventListener("change", calculate);
  });
  el("reset").addEventListener("click", resetDefaults);

  const observer = new ResizeObserver(() => {
    if (lastSimulation) drawChart(lastSimulation.rows, lastSimulation.annualRows, lastSimulation.params);
  });
  observer.observe(el("chartWrap"));
  calculate();
}

init();

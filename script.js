const defaults = {
  debt: 35000,
  income: 42000,
  partnerIncome: 0,
  household: "single",
  interest: 2.33,
  fixedYears: 5,
  incomeGrowth: 3.0,
  exemptionGrowth: 2.5,
  futureInterest: 2.33,
  extraPayment: 0,
  pauseMonths: 0,
  years: 35,
  incomeLag: true,
  roundDown: true
};

const el = id => document.getElementById(id);
const money = value => new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value || 0);
const number = id => Number(el(id).value || 0);

const inputs = Array.from(document.querySelectorAll("input, select"));
inputs.forEach(input => input.addEventListener("input", calculate));
el("reset").addEventListener("click", () => {
  Object.entries(defaults).forEach(([key, value]) => {
    const input = el(key);
    if (!input) return;
    if (input.type === "checkbox") input.checked = value;
    else input.value = value;
  });
  calculate();
});

function monthlyRate(annualPercent) {
  return Math.pow(1 + annualPercent / 100, 1 / 12) - 1;
}

function annuity(balance, rate, months) {
  if (balance <= 0 || months <= 0) return 0;
  if (rate === 0) return balance / months;
  return balance * rate / (1 - Math.pow(1 + rate, -months));
}

function calculate() {
  const debt = number("debt");
  const baseIncome = number("income");
  const basePartner = number("partnerIncome");
  const household = el("household").value;
  const interest = number("interest");
  const fixedYears = Math.max(1, number("fixedYears"));
  const futureInterest = number("futureInterest");
  const incomeGrowth = number("incomeGrowth") / 100;
  const exemptionGrowth = number("exemptionGrowth") / 100;
  const extraPayment = number("extraPayment");
  const pauseMonths = Math.min(60, Math.max(0, Math.round(number("pauseMonths"))));
  const years = Math.max(1, Math.round(number("years")));
  const useLag = el("incomeLag").checked;
  const roundDown = el("roundDown").checked;

  const standardMonths = 35 * 12;
  const totalMonths = Math.min(years * 12 + pauseMonths, standardMonths + pauseMonths);
  const baseExemption = household === "single" ? 26819.42 : 38351.77;
  const data = [];
  const annualRows = [];
  let balance = debt;
  let totalPaid = 0;
  let paidOffMonth = null;
  let maxPayment = 0;

  for (let month = 1; month <= totalMonths; month++) {
    const yearIndex = Math.floor((month - 1) / 12);
    const incomeYear = Math.max(0, yearIndex - (useLag ? 2 : 0));
    const currentIncome = (baseIncome + basePartner) * Math.pow(1 + incomeGrowth, incomeYear);
    const currentExemption = baseExemption * Math.pow(1 + exemptionGrowth, yearIndex);
    const annualCapacity = Math.max(0, (currentIncome - currentExemption) * 0.04);
    let capacity = annualCapacity / 12;
    if (capacity < 5) capacity = 0;
    if (roundDown) capacity = Math.floor(capacity);

    const active = month > pauseMonths;
    const monthsElapsedInAflosfase = Math.max(0, month - pauseMonths - 1);
    const remainingMonths = Math.max(1, standardMonths - monthsElapsedInAflosfase);
    const annualInterest = month <= fixedYears * 12 ? interest : futureInterest;
    const rate = monthlyRate(annualInterest);
    const interestAdded = balance * rate;
    balance += interestAdded;

    const standardPayment = annuity(balance, rate, remainingMonths);
    let required = active ? Math.min(capacity, standardPayment) : 0;
    if (balance <= 0) required = 0;
    const payment = Math.min(balance, required + (active ? extraPayment : 0));
    balance = Math.max(0, balance - payment);
    totalPaid += payment;
    maxPayment = Math.max(maxPayment, payment);

    if (!paidOffMonth && balance <= 0.01) paidOffMonth = month;

    data.push({
      month,
      year: yearIndex + 1,
      balance,
      payment,
      capacity,
      standardPayment,
      currentIncome,
      currentExemption,
      interestAdded
    });

    if (month % 12 === 0 || month === totalMonths || balance <= 0) {
      const monthsThisYear = data.filter(row => row.year === yearIndex + 1);
      annualRows.push({
        year: yearIndex + 1,
        income: currentIncome,
        exemption: currentExemption,
        capacity,
        paid: monthsThisYear.reduce((sum, row) => sum + row.payment, 0),
        balance
      });
    }

    if (balance <= 0.01) break;
  }

  const firstActive = data.find(row => row.payment > 0) || data.find(row => row.month > pauseMonths) || data[0];
  const avgPayment = data.length ? totalPaid / data.length : 0;
  const forgiven = balance > 0 ? balance : 0;

  el("heroPayment").textContent = money(firstActive ? firstActive.payment : 0);
  el("firstPayment").textContent = money(firstActive ? firstActive.payment : 0);
  el("avgPayment").textContent = money(avgPayment);
  el("totalPaid").textContent = money(totalPaid);
  el("forgiven").textContent = money(forgiven);
  el("paidOffMonth").textContent = paidOffMonth ? `Maand ${paidOffMonth}` : "Niet binnen periode";
  el("maxPayment").textContent = money(maxPayment);

  renderTable(annualRows);
  drawChart(data);
}

function renderTable(rows) {
  el("yearRows").innerHTML = rows.map(row => `
    <tr>
      <td>${row.year}</td>
      <td>${money(row.income)}</td>
      <td>${money(row.exemption)}</td>
      <td>${money(row.capacity)}</td>
      <td>${money(row.paid)}</td>
      <td>${money(row.balance)}</td>
    </tr>
  `).join("");
}

function drawChart(data) {
  const canvas = el("chart");
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.font = "14px system-ui";
  ctx.lineWidth = 2;

  const pad = { left: 70, right: 24, top: 28, bottom: 48 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;
  const maxBalance = Math.max(...data.map(d => d.balance), number("debt"), 1);
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

  ctx.strokeStyle = "#215cff";
  ctx.beginPath();
  data.forEach((d, i) => {
    const px = x(i);
    const py = yBalance(d.balance);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  ctx.strokeStyle = "#0f7a4f";
  ctx.beginPath();
  data.forEach((d, i) => {
    const px = x(i);
    const py = yPayment(d.payment);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  ctx.fillStyle = "#172033";
  ctx.textAlign = "left";
  ctx.fillText("Schuld", pad.left, 20);
  ctx.fillStyle = "#0f7a4f";
  ctx.fillText("Maandbetaling", pad.left + 80, 20);

  ctx.fillStyle = "#637083";
  ctx.textAlign = "center";
  ctx.fillText("Maanden", pad.left + plotW / 2, h - 12);
}

calculate();

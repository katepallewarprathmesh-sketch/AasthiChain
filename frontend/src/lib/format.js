// Indian currency formatting.
// moneyExact: full precision with Indian digit grouping — ₹1,20,00,000
// money:      Lakh/Crore compaction per Indian market convention —
//             ≥ 1 Cr → ₹1.2 Cr · ≥ 1 L → ₹7.2 L · else exact grouping
export function moneyExact(n) {
  return '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN')
}

export function money(n) {
  const v = Number(n) || 0
  const a = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  const trim = (x) => String(Math.round(x * 100) / 100)
  if (a >= 1e7) return `${sign}₹${trim(a / 1e7)} Cr`
  if (a >= 1e5) return `${sign}₹${trim(a / 1e5)} L`
  return moneyExact(v)
}

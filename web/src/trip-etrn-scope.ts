/** Missing flags preserve the historical behavior. Accounting and driver scope stay intact. */
export const requiresEtrn = (row: { fields: Record<string, string | null> }) => row.fields.etrn_not_required !== 'true'

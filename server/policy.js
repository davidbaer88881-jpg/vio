// ============================================================================
//  VIO – ABSOLUTE BUDGET- UND ZAHLUNGSREGELN
//  Diese Regeln stehen im Code, nicht im Prompt. Kein Chat-Text, keine
//  KI-Antwort und kein Tool-Aufruf kann sie aufheben. Ändern lässt sich nur
//  die Obergrenze max_budget_eur – und das nur mit Passwort in den Einstellungen.
// ============================================================================

// Aktionen, die Vio NIEMALS ausführen darf – unabhängig von Budget oder Erlaubnis.
export const FORBIDDEN_ACTIONS = Object.freeze({
  payment: 'Vio bezahlt niemals selbst.',
  bank_transfer: 'Banküberweisungen sind für Vio gesperrt.',
  card_payment: 'Vio verwendet niemals Kreditkartendaten.',
  paypal: 'PayPal-Zahlungen sind für Vio gesperrt.',
  online_purchase: 'Vio kauft nichts online und bezahlt nichts.',
  subscription: 'Vio schließt keine Abonnements ab.',
  contract: 'Vio schließt keine Verträge ab.',
});

// Aktionen, die mit Budget erlaubt sein können (Bezahlung erfolgt immer durch dich,
// z. B. bar bei Lieferung oder vor Ort).
export const BUDGETED_ACTIONS = Object.freeze(['order', 'reservation', 'booking', 'appointment', 'service']);

// Zahlungsarten, bei denen nicht Vio, sondern du bezahlst.
export const ALLOWED_PAYMENT_METHODS = Object.freeze(['cash_on_delivery', 'pay_on_site', 'invoice_to_user', 'none']);

const EURO_RE = /(?:€\s*(\d{1,5}(?:[.,]\d{1,2})?))|(?:(\d{1,5}(?:[.,]\d{1,2})?)\s*(?:€|eur\b|euro\b|euros\b|öcken|tacken))/gi;

/** Findet alle Euro-Beträge in einem Text, z. B. "maximal 20 Euro" → [20]. */
export function extractEuroAmounts(text) {
  const out = [];
  for (const m of String(text || '').matchAll(EURO_RE)) {
    const raw = (m[1] || m[2]).replace(',', '.');
    const n = Number(raw);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * Prüft eine geplante kostenpflichtige Aktion.
 *
 * @param {object} action
 *   action_type, merchant, description, budget_eur, estimated_total_eur, payment_method
 * @param {object} ctx
 *   userTexts: string[]  – die Original-Nachrichten des Nutzers in diesem Gespräch
 *   maxBudgetEur: number – absolute Obergrenze aus den geschützten Einstellungen
 * @returns {{decision: 'allow'|'deny'|'ask_user'|'need_price', reason: string}}
 */
export function evaluateAction(action, ctx) {
  const type = String(action?.action_type || '').toLowerCase();
  const maxBudget = Number(ctx?.maxBudgetEur ?? 0);

  // Regel 1: Verbotene Aktionen – immer ablehnen.
  if (type in FORBIDDEN_ACTIONS) return { decision: 'deny', reason: FORBIDDEN_ACTIONS[type] };

  // Unbekannte Aktionstypen werden sicherheitshalber abgelehnt.
  if (!BUDGETED_ACTIONS.includes(type)) return { decision: 'deny', reason: `Unbekannter Aktionstyp „${type}“ – aus Sicherheitsgründen abgelehnt.` };

  // Regel 2: Vio bezahlt nie selbst – nur Zahlarten, bei denen du zahlst.
  const pm = String(action.payment_method || 'none');
  if (!ALLOWED_PAYMENT_METHODS.includes(pm)) {
    return { decision: 'deny', reason: 'Vio darf nicht selbst bezahlen. Erlaubt ist nur: Du bezahlst bar/vor Ort/per Rechnung.' };
  }

  const total = action.estimated_total_eur;
  const budget = action.budget_eur;
  const hasTotal = typeof total === 'number' && Number.isFinite(total) && total >= 0;
  const hasBudget = typeof budget === 'number' && Number.isFinite(budget) && budget > 0;

  // Kostenlose Aktion (z. B. Tischreservierung ohne Gebühr) ist erlaubt.
  if (hasTotal && total === 0) return { decision: 'allow', reason: 'Kostenlose Aktion.' };

  // Regel 3: Ohne Budget → nachfragen.
  if (!hasBudget) return { decision: 'ask_user', reason: 'Kein Budget genannt. Vio muss dich vorher fragen.' };

  // Regel 4: Das Budget muss wirklich von dir stammen (in deinen eigenen Nachrichten stehen).
  //          So kann die KI kein Budget erfinden oder hochsetzen.
  const stated = (ctx?.userTexts || []).flatMap(extractEuroAmounts);
  if (!stated.some((n) => Math.abs(n - budget) < 0.005)) {
    return { decision: 'ask_user', reason: `Ein Budget von ${budget} € hast du nicht selbst genannt. Vio muss nachfragen.` };
  }

  // Regel 5: Absolute Obergrenze aus den geschützten Einstellungen.
  if (budget > maxBudget) {
    return { decision: 'deny', reason: `Budget ${budget} € liegt über deiner festen Obergrenze von ${maxBudget} € (änderbar nur mit Passwort in den Einstellungen).` };
  }

  // Regel 6: Gesamtpreis unbekannt → zuerst erfragen.
  if (!hasTotal) return { decision: 'need_price', reason: 'Gesamtpreis (inkl. Liefer- und Zusatzkosten) ist unbekannt und muss zuerst erfragt werden.' };

  // Regel 7: Budget niemals überschreiten.
  if (total > budget) return { decision: 'deny', reason: `Gesamtpreis ${total} € überschreitet dein Budget von ${budget} €.` };

  return { decision: 'allow', reason: `Innerhalb des Budgets (${total} € von ${budget} €). Bezahlung erfolgt durch dich.` };
}

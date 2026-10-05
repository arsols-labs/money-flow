// Two hints for the account form (issue #235, account rules in ROADMAP).
//
// Both are about the moment when a real set of accounts is entered by hand,
// for the first time and in a row: v2 has no import from Sheets. Neither of them
// forbids anything — the rules explicitly call both identical names and two accounts
// with one triple (owner, currency, country) legitimate. The logic lives here as pure
// functions so it can be checked by tests without the DOM: a React render is not
// brought up in v2 tests; the pool runs in workerd.

const SEPARATOR = ' · ';

// Empty, whitespace, undefined — all of these mean "the field is not filled in".
function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Default name: "Type · Currency · Country" — "Cash · USD · Global".
 * The owner is not part of the name: by rule it is the card's caption.
 * Type and country are free text (v2 has no directories), so
 * they are inserted as-is; currency is uppercased because
 * that is the form in which it is stored.
 *
 * Until the whole triple is filled in, there is nothing to suggest: "Cash · · Global"
 * is not a name, it is a half-finished one.
 */
export function suggestAccountName(form) {
  const type = clean(form?.type);
  const currency = clean(form?.currency).toUpperCase();
  const country = clean(form?.country);
  if (!type || !currency || !country) return '';
  return [type, currency, country].join(SEPARATOR);
}

/**
 * What to put in the "Name" field, or null — "do not touch".
 *
 * `touched` means the name was already typed by hand. That is never overwritten:
 * an explicit entry is a stronger signal of intent than a suggested value (the same
 * rule as the balance field in AccountForm). A name erased to empty is also
 * manual input: the hint sets a starting value, not a format, and
 * it must not come back after a deletion.
 *
 * An incomplete triple does not erase what is already in the field: someone correcting
 * the currency should not see the name disappear for the duration of the edit.
 */
export function suggestedNameUpdate(form, { touched } = {}) {
  if (touched) return null;
  const suggestion = suggestAccountName(form);
  if (!suggestion || suggestion === clean(form?.name)) return null;
  return suggestion;
}

function key(value) {
  return clean(value).toLowerCase();
}

/**
 * A similar account is the same owner, the same currency, and the same country, ignoring
 * case and surrounding whitespace. Returns the first match or null.
 *
 * The name is left out of the comparison on purpose: identical names are allowed by the
 * same rule, and a duplicate name by itself is not a reason to warn.
 *
 * Archived accounts do not count: a "wallet" from the archive does not block creating a new account of the same
 * triple, and a warning about it would make the owner look for an account
 * that is not visible in the list.
 *
 * The function serves account creation. It is unfit for editing an existing account:
 * the account would find itself — and it is not needed, because the warning is shown
 * only on the create form.
 */
export function findSimilarAccount(accounts, form) {
  const owner = key(form?.owner);
  const currency = key(form?.currency);
  const country = key(form?.country);
  if (!owner || !currency || !country) return null;
  return (accounts || []).find((acc) => (
    !acc.archived
    && key(acc.owner) === owner
    && key(acc.currency) === currency
    && key(acc.country) === country
  )) || null;
}

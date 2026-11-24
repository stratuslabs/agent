import { el } from './dom.js';

/**
 * Bring a `<select>`'s options up to date without disturbing a choice.
 *
 * The option lists here are data — models a sign-in can reach, agents on the
 * roster — and they arrive after the form is already on screen. Rebuilding
 * the whole pane to show them would throw away everything typed into it, so
 * the select is kept and only its options are replaced, restoring the current
 * value when it survived the refresh.
 */
export const syncOptions = (select, options, fallback) => {
  const signature = options.map((option) => option.value).join(' ');
  if (select.dataset.signature === signature) {
    return;
  }
  select.dataset.signature = signature;
  // A choice someone made survives; a value the browser merely settled on
  // does not. The pane renders once before its data arrives, so the picker
  // starts on whatever the empty option list allowed — and treating that as a
  // selection meant the configured model never got selected when it finally
  // appeared, leaving the picker on "follow the default" and the next Save
  // deleting a pin nobody touched.
  const chosen = select.dataset.touched === 'yes' ? select.value : fallback;
  select.replaceChildren(...options.map((option) => el('option', { value: option.value }, option.label)));
  const wanted = options.some((option) => option.value === chosen) ? chosen : fallback;
  if (wanted !== undefined) {
    select.value = wanted;
  }
};

/** Mark a select as carrying a real choice rather than a default. */
export const touchOnChange = (select) => {
  select.addEventListener('change', () => { select.dataset.touched = 'yes'; });
  return select;
};


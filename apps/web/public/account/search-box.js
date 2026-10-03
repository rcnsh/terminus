// The destination search box: a text box with a short, ranked, grouped list
// under it (the ranking is search.js's). Replaces the browser's <datalist>,
// which listed every entry at once and couldn't say where a room or building
// actually takes you. Used in Settings (a class's place, a favourite) and on
// the web app's Now (Go somewhere else).

import { html, useId, useLayoutEffect, useRef, useState } from '../assets/ui.js';
import { t } from './dom.js';
import { groupOf, metaOf, pickedText, results } from './search.js';

/**
 * `source()` gives the destinations, `suggestions()` what to offer before
 * anything is typed, `pinned()` what to list first whenever it matches,
 * `stopName(code)` a stop's name. `onPick(d)` gets the result picked;
 * `onText(text)` each change typed (no result picked any more). `ctl`, a
 * ref, gets { clear(), focus(), input }. Other props go to the text box.
 */
export function SearchBox({ source, suggestions = () => [], pinned, stopName, onPick, onText, onKeyDown, ctl, ...inputProps }) {
  const listId = `search-${useId()}`;
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [flip, setFlip] = useState(false);
  const input = useRef(null);
  const wrap = useRef(null);
  const list = useRef(null);

  const items = open ? results(text, { source, suggestions, pinned }) : [];
  const shown = open && (items.length > 0 || text.trim() !== '');

  if (ctl) {
    ctl.current = {
      get input() {
        return input.current;
      },
      focus: () => input.current?.focus(),
      clear: () => {
        setText('');
        setOpen(false);
      },
    };
  }

  // Wide enough to read even under a narrow box; kept on screen by opening
  // leftwards when there's no room to the right.
  useLayoutEffect(() => {
    if (!shown || !list.current) return;
    const box = wrap.current.getBoundingClientRect();
    setFlip(box.left + list.current.offsetWidth > document.documentElement.clientWidth - 8);
  }, [shown, items.length]);

  const close = () => {
    setOpen(false);
    setActive(-1);
  };

  const pick = (d) => {
    setText(pickedText(d));
    input.current?.setCustomValidity('');
    close();
    onPick?.(d);
  };

  const typed = (value) => {
    setText(value);
    setOpen(true);
    const next = results(value, { source, suggestions, pinned });
    setActive(next.length && value.trim() ? 0 : -1);
    input.current?.setCustomValidity('');
    onText?.(value);
  };

  const keys = (e) => {
    if (!shown && e.key === 'ArrowDown') {
      setOpen(true);
      return;
    }
    if (shown && e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(Math.min(items.length - 1, active + 1));
    } else if (shown && e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(Math.max(0, active - 1));
    } else if (shown && e.key === 'Enter' && active >= 0 && items[active]) {
      e.preventDefault();
      pick(items[active]);
      return;
    } else if (shown && e.key === 'Escape') {
      close();
    }
    onKeyDown?.(e);
  };

  let group = null;
  const rows = [];
  items.forEach((d, i) => {
    if (d.kind !== group) {
      group = d.kind;
      rows.push(html`<li class="search-group" role="presentation" key=${`g-${group}`}>${groupOf(d)}</li>`);
    }
    rows.push(html`
      <li
        id=${`${listId}-${i}`}
        key=${`${d.kind}-${d.code}`}
        role="option"
        class=${i === active ? 'active' : ''}
        aria-selected=${String(i === active)}
        onMouseDown=${(e) => {
          // mousedown, not click: the box's blur would close the list first.
          e.preventDefault();
          pick(d);
        }}
      >
        <span class="search-title">${d.label}</span>
        <span class="search-meta">${metaOf(d, stopName)}</span>
      </li>
    `);
  });

  return html`
    <div class="search" ref=${wrap}>
      <input
        ...${inputProps}
        ref=${input}
        value=${text}
        role="combobox"
        autocomplete="off"
        aria-autocomplete="list"
        aria-expanded=${String(shown)}
        aria-controls=${listId}
        aria-activedescendant=${shown && active >= 0 ? `${listId}-${active}` : undefined}
        onInput=${(e) => typed(e.currentTarget.value)}
        onFocus=${() => setOpen(true)}
        onBlur=${() => setTimeout(close, 0)}
        onKeyDown=${keys}
      />
      <ul id=${listId} ref=${list} class=${flip ? 'search-list flip' : 'search-list'} role="listbox" hidden=${!shown}>
        ${rows.length ? rows : html`<li class="search-empty">${t('No stop, building or room by that name')}</li>`}
      </ul>
    </div>
  `;
}

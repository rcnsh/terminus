import { html, useEffect, useId, useLayoutEffect, useRef, useState } from '../assets/ui.js';
import { t } from './dom.js';
import { walkSpeed } from './profile.js';
import { groupKey, groupOf, grouped, metaOf, pickedText, results } from './search.js';

const COUNT_AFTER_MS = 500;

export function SearchBox({
  source,
  suggestions = () => [],
  pinned,
  stopName,
  empty = t('No stop, building or room by that name'),
  onPick,
  onText,
  onKeyDown,
  ctl,
  ...inputProps
}) {
  const listId = `search-${useId()}`;
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [flip, setFlip] = useState(false);
  const input = useRef(null);
  const wrap = useRef(null);
  const list = useRef(null);

  const items = open ? grouped(results(text, { source, suggestions, pinned })) : [];
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

  const groups = [];
  items.forEach((d, i) => {
    if (groups.at(-1)?.kind !== groupKey(d)) groups.push({ kind: groupKey(d), name: groupOf(d), rows: [] });
    groups.at(-1).rows.push(html`
      <li
        id=${`${listId}-${i}`}
        key=${`${d.kind}-${d.code}`}
        role="option"
        class=${i === active ? 'active' : ''}
        aria-selected=${String(i === active)}
        onMouseDown=${(e) => {
          e.preventDefault();
          pick(d);
        }}
      >
        <span class="search-title">${d.label}</span>
        <span class="search-meta">${metaOf(d, stopName, walkSpeed.get())}</span>
      </li>
    `);
  });
  const count =
    !shown || !text.trim() ? '' : items.length === 0 ? empty : items.length === 1 ? t('1 result') : t('{0} results', items.length);
  const [said, setSaid] = useState('');
  useEffect(() => {
    if (!count) {
      setSaid('');
      return;
    }
    const id = setTimeout(() => setSaid(count), COUNT_AFTER_MS);
    return () => clearTimeout(id);
  }, [count, text]);

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
        ${
          groups.length
            ? groups.map(
                (g) => html`<li role="group" aria-label=${g.name} key=${`g-${g.kind}`}>
                <div class="search-group" aria-hidden="true">${g.name}</div>
                <ul class="search-sub" role="none">${g.rows}</ul>
              </li>`,
              )
            : html`<li class="search-empty" role="none">${empty}</li>`
        }
      </ul>
      <p class="sr-only" role="status">${said}</p>
    </div>
  `;
}

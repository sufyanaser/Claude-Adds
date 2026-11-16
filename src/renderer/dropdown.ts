export interface DropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
}

const SEARCH_FROM = 9;
const normalize = (text: string) => text.toLowerCase().replace(/[ً-ٟـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');

/** Closes whichever menu is open. Only one can be open at a time. */
let closeOpen: ((refocus: boolean) => void) | null = null;

/**
 * Select-style menu that matches the app in both themes and in RTL.
 * The list is drawn in a fixed layer above the page, so it is never clipped
 * by the table and never shifts the layout. It opens upward when there is
 * no room below, and works with the keyboard alone.
 */
export class Dropdown {
  private readonly button: HTMLButtonElement;
  private readonly valueText: HTMLSpanElement;
  private pop: HTMLDivElement | null = null;
  private options: DropdownOption[] = [];
  private current = '';
  private active = 0;
  private filter = '';

  constructor(
    host: HTMLElement,
    private readonly key: string,
    private readonly label: string,
    private readonly onChange: (value: string) => void,
  ) {
    this.valueText = document.createElement('span');
    this.valueText.className = 'dd-value';
    const caret = document.createElement('span');
    caret.className = 'dd-caret';
    caret.setAttribute('aria-hidden', 'true');
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'dd-button';
    this.button.dataset.dd = key;
    this.button.setAttribute('aria-haspopup', 'listbox');
    this.button.setAttribute('aria-expanded', 'false');
    this.button.append(this.valueText, caret);
    host.append(this.button);

    this.button.addEventListener('click', () => (this.pop ? this.close(true) : this.open()));
    this.button.addEventListener('keydown', (event) => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key) && !this.pop) {
        event.preventDefault();
        this.open();
      }
    });
  }

  get value(): string {
    return this.current;
  }

  setOptions(options: DropdownOption[], value: string): void {
    this.options = options;
    this.current = options.some((option) => option.value === value) ? value : (options[0]?.value ?? '');
    const selected = options.find((option) => option.value === this.current);
    this.valueText.textContent = selected?.label ?? '';
    this.button.dataset.value = this.current;
    this.button.setAttribute('aria-label', `${this.label}: ${selected?.label ?? ''}`);
    this.button.disabled = options.length <= 1;
  }

  private visible(): DropdownOption[] {
    const query = normalize(this.filter.trim());
    return query ? this.options.filter((option) => normalize(option.label).includes(query)) : this.options;
  }

  private open(): void {
    closeOpen?.(false);
    closeOpen = (refocus) => this.close(refocus);
    this.filter = '';
    this.active = Math.max(0, this.options.findIndex((option) => option.value === this.current));

    const pop = document.createElement('div');
    pop.className = 'dd-pop';
    pop.dataset.ddPop = this.key;
    pop.dir = 'rtl';
    this.pop = pop;

    let search: HTMLInputElement | null = null;
    if (this.options.length >= SEARCH_FROM) {
      search = document.createElement('input');
      search.type = 'search';
      search.className = 'dd-search';
      search.placeholder = 'ابحث في القائمة';
      search.setAttribute('aria-label', `بحث في ${this.label}`);
      search.dir = 'auto';
      search.addEventListener('input', () => {
        this.filter = search?.value ?? '';
        this.active = 0;
        this.renderList();
      });
      pop.append(search);
    }
    const list = document.createElement('div');
    list.className = 'dd-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', this.label);
    list.tabIndex = -1;
    pop.append(list);
    document.body.append(pop);
    this.renderList();
    this.place();

    pop.addEventListener('keydown', (event) => this.onKey(event));
    this.button.setAttribute('aria-expanded', 'true');
    // The class is added a frame later so the opening transition runs.
    requestAnimationFrame(() => pop.classList.add('open'));
    (search ?? list).focus();

    document.addEventListener('pointerdown', this.onOutside, true);
    window.addEventListener('resize', this.onMove);
    window.addEventListener('scroll', this.onMove, true);
  }

  private renderList(): void {
    const list = this.pop?.querySelector<HTMLDivElement>('.dd-list');
    if (!list) return;
    const visible = this.visible();
    this.active = Math.min(this.active, Math.max(0, visible.length - 1));
    list.replaceChildren(
      ...visible.map((option, index) => {
        const row = document.createElement('div');
        row.className = 'dd-option';
        row.id = `dd-${this.key}-${index}`;
        row.setAttribute('role', 'option');
        row.dataset.value = option.value;
        row.setAttribute('aria-selected', option.value === this.current ? 'true' : 'false');
        if (option.disabled) row.setAttribute('aria-disabled', 'true');
        if (index === this.active) row.classList.add('active');
        const mark = document.createElement('span');
        mark.className = 'dd-check';
        mark.setAttribute('aria-hidden', 'true');
        mark.textContent = option.value === this.current ? '✓' : '';
        const text = document.createElement('span');
        text.textContent = option.label;
        row.append(mark, text);
        row.addEventListener('pointermove', () => this.setActive(index));
        row.addEventListener('click', () => !option.disabled && this.choose(option.value));
        return row;
      }),
    );
    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dd-empty';
      empty.textContent = 'لا خيار يطابق البحث';
      list.append(empty);
    }
    list.setAttribute('aria-activedescendant', visible.length ? `dd-${this.key}-${this.active}` : '');
  }

  private setActive(index: number): void {
    if (index === this.active) return;
    this.active = index;
    const rows = this.pop?.querySelectorAll<HTMLElement>('.dd-option') ?? [];
    rows.forEach((row, i) => row.classList.toggle('active', i === index));
    rows[index]?.scrollIntoView({ block: 'nearest' });
    this.pop?.querySelector('.dd-list')?.setAttribute('aria-activedescendant', `dd-${this.key}-${index}`);
  }

  /** Aligns the list with the button's right edge (the start edge in RTL) and flips it up when needed. */
  private place(): void {
    if (!this.pop) return;
    const rect = this.button.getBoundingClientRect();
    const width = Math.max(rect.width, 220);
    this.pop.style.width = `${width}px`;
    const height = this.pop.offsetHeight;
    const below = window.innerHeight - rect.bottom - 8;
    const up = below < height && rect.top - 8 > below;
    this.pop.dataset.side = up ? 'top' : 'bottom';
    this.pop.style.maxHeight = `${Math.max(140, (up ? rect.top : window.innerHeight - rect.bottom) - 16)}px`;
    this.pop.style.top = up ? '' : `${rect.bottom + 4}px`;
    this.pop.style.bottom = up ? `${window.innerHeight - rect.top + 4}px` : '';
    this.pop.style.left = `${Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8)}px`;
  }

  private onKey(event: KeyboardEvent): void {
    const visible = this.visible();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (visible.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      let next = this.active;
      // Skip disabled options.
      for (let i = 0; i < visible.length; i++) {
        next = (next + step + visible.length) % visible.length;
        if (!visible[next]?.disabled) break;
      }
      this.setActive(next);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      this.setActive(event.key === 'Home' ? 0 : visible.length - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const option = visible[this.active];
      if (option && !option.disabled) this.choose(option.value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close(true);
    } else if (event.key === 'Tab') {
      this.close(true);
    }
  }

  private choose(value: string): void {
    const changed = value !== this.current;
    this.close(true);
    if (changed) this.onChange(value);
  }

  private readonly onOutside = (event: Event): void => {
    const target = event.target as Node;
    if (!this.pop?.contains(target) && !this.button.contains(target)) this.close(false);
  };

  private readonly onMove = (event: Event): void => {
    // Scrolling the option list itself must not close it.
    if (event.type === 'scroll' && this.pop?.contains(event.target as Node)) return;
    this.close(false);
  };

  close(refocus: boolean): void {
    if (!this.pop) return;
    this.pop.remove();
    this.pop = null;
    closeOpen = null;
    this.button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', this.onOutside, true);
    window.removeEventListener('resize', this.onMove);
    window.removeEventListener('scroll', this.onMove, true);
    if (refocus) this.button.focus();
  }
}


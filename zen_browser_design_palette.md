# Zen Browser — дизайн-палитра

Источник: `https://zen-browser.app/` + публичный репозиторий `zen-browser/www`.
Дата снятия: 2026-06-26.

Палитра построена вокруг тёплого «paper» фона, мягкого тёмного текста и кораллового бренд-акцента. Визуальный характер: спокойный, приватный, минималистичный, с тёплым editorial/web-product ощущением.

---

## 1. Core palette

| Token | HEX / RGBA | Swatch | Роль |
|---|---:|---|---|
| `zen.paper.light` | `#F2F0E3` | <span style="display:inline-block;width:48px;height:18px;border:1px solid #ccc;background:#F2F0E3;border-radius:4px"></span> | Основной светлый фон, cream/paper |
| `zen.text.light` | `#2E2E2E` | <span style="display:inline-block;width:48px;height:18px;border:1px solid #ccc;background:#2E2E2E;border-radius:4px"></span> | Основной текст и dark-кнопки в light theme |
| `zen.paper.dark` | `#1F1F1F` | <span style="display:inline-block;width:48px;height:18px;border:1px solid #ccc;background:#1F1F1F;border-radius:4px"></span> | Основной тёмный фон |
| `zen.text.dark` | `#D1CFC0` | <span style="display:inline-block;width:48px;height:18px;border:1px solid #ccc;background:#D1CFC0;border-radius:4px"></span> | Основной текст в dark theme |
| `zen.coral` | `#F76F53` | <span style="display:inline-block;width:48px;height:18px;border:1px solid #ccc;background:#F76F53;border-radius:4px"></span> | Главный бренд-акцент: лого, ссылки, выделения |
| `zen.meta.coral` | `#DA755B` | <span style="display:inline-block;width:48px;height:18px;border:1px solid #ccc;background:#DA755B;border-radius:4px"></span> | Browser/theme/OG accent color |
| `zen.blue` | `#6287F5` | <span style="display:inline-block;width:48px;height:18px;border:1px solid #ccc;background:#6287F5;border-radius:4px"></span> | Secondary accent, Twilight/download states |
| `zen.green` | `#63F78B` | <span style="display:inline-block;width:48px;height:18px;border:1px solid #ccc;background:#63F78B;border-radius:4px"></span> | Secondary/success-like accent |

---

## 2. Surface tokens

| Token | Light | Dark | Роль |
|---|---:|---:|---|
| `zen.surface.base` | `#F2F0E3` | `#1F1F1F` | Page background |
| `zen.surface.muted` | `rgba(0,0,0,0.05)` | `rgba(255,255,255,0.05)` | Dropdown hover, soft cards |
| `zen.surface.subtle` | `rgba(0,0,0,0.05)` | `rgba(255,255,255,0.10)` | Pills, secondary buttons, selected features |
| `zen.border.strong` | `#2E2E2E` | `#D1CFC0` | Borders, outlined buttons |
| `zen.text.primary` | `#2E2E2E` | `#D1CFC0` | Main text |
| `zen.text.invert` | `#F2F0E3` | `#1F1F1F` | Text on primary/dark buttons |

### Composited approximations

Если нужно использовать не RGBA, а solid-цвета:

| Token | Solid light approximation | Solid dark approximation |
|---|---:|---:|
| `surface.muted` / `surface.subtle` 5% | `#E6E4D8` | `#2A2A2A` |
| `surface.subtle` 10% | — | `#353535` |
| `zen.blue / 5%` | `#EBEBE4` | — |
| `zen.blue / 20%` | `#D5DBE7` | — |

---

## 3. Semantic roles

### Light theme

| Role | Token | Value |
|---|---|---:|
| Background | `bg.paper` | `#F2F0E3` |
| Text | `text.primary` | `#2E2E2E` |
| Primary button background | `button.primary.bg` | `#2E2E2E` |
| Primary button text | `button.primary.text` | `#F2F0E3` |
| Secondary button/card | `button.secondary.bg` | `rgba(0,0,0,0.05)` |
| Accent text/link/logo | `accent.coral` | `#F76F53` |
| Accent secondary | `accent.blue` | `#6287F5` |
| Accent success/green | `accent.green` | `#63F78B` |

### Dark theme

| Role | Token | Value |
|---|---|---:|
| Background | `bg.paper` | `#1F1F1F` |
| Text | `text.primary` | `#D1CFC0` |
| Primary button background | `button.primary.bg` | `#D1CFC0` |
| Primary button text | `button.primary.text` | `#1F1F1F` |
| Secondary button/card | `button.secondary.bg` | `rgba(255,255,255,0.05)` |
| Selected/active surface | `surface.selected` | `rgba(255,255,255,0.10)` |
| Accent text/link/logo | `accent.coral` | `#F76F53` |
| Accent secondary | `accent.blue` | `#6287F5` |
| Accent success/green | `accent.green` | `#63F78B` |

---

## 4. Contrast notes

| Pair | Contrast | Usage note |
|---|---:|---|
| `#2E2E2E` on `#F2F0E3` | `11.87:1` | Отлично для основного текста |
| `#D1CFC0` on `#1F1F1F` | `10.52:1` | Отлично для dark theme текста |
| `#F76F53` on `#1F1F1F` | `5.77:1` | Можно для текста в dark theme |
| `#F76F53` on `#F2F0E3` | `2.50:1` | Лучше для крупных заголовков/акцентов, не для мелкого текста |
| `#6287F5` on `#1F1F1F` | `4.95:1` | Нормально для текста/иконок в dark theme |
| `#6287F5` on `#F2F0E3` | `2.91:1` | Лучше для крупных акцентов, не для мелкого текста |
| `#63F78B` on `#1F1F1F` | `11.94:1` | Отлично на тёмном фоне |
| `#63F78B` on `#F2F0E3` | `1.21:1` | Не использовать как текст на светлом фоне |

---

## 5. CSS variables

```css
:root {
  --zen-paper: #f2f0e3;
  --zen-dark: #2e2e2e;
  --zen-muted: rgba(0, 0, 0, 0.05);
  --zen-subtle: rgba(0, 0, 0, 0.05);

  --zen-coral: #f76f53;
  --zen-meta-coral: #da755b;
  --zen-blue: #6287f5;
  --zen-green: #63f78b;
}

:root[data-theme='dark'] {
  --zen-paper: #1f1f1f;
  --zen-dark: #d1cfc0;
  --zen-muted: rgba(255, 255, 255, 0.05);
  --zen-subtle: rgba(255, 255, 255, 0.1);
}
```

---

## 6. Design token JSON

```json
{
  "color": {
    "zen": {
      "paper": {
        "light": "#F2F0E3",
        "dark": "#1F1F1F"
      },
      "text": {
        "light": "#2E2E2E",
        "dark": "#D1CFC0"
      },
      "accent": {
        "coral": "#F76F53",
        "metaCoral": "#DA755B",
        "blue": "#6287F5",
        "green": "#63F78B"
      },
      "surface": {
        "mutedLight": "rgba(0, 0, 0, 0.05)",
        "subtleLight": "rgba(0, 0, 0, 0.05)",
        "mutedDark": "rgba(255, 255, 255, 0.05)",
        "subtleDark": "rgba(255, 255, 255, 0.10)"
      }
    }
  }
}
```

---

## 7. Tailwind-style mapping

```js
export const zenPalette = {
  paper: 'var(--zen-paper)',
  dark: 'var(--zen-dark)',
  subtle: 'var(--zen-subtle)',
  muted: 'var(--zen-muted)',
  coral: '#f76f53',
  zenBlue: '#6287f5',
  zenGreen: '#63f78b',
}
```

---

## 8. Quick usage guide

- Используй `paper` как основной фон, а не чистый белый — это даёт фирменное спокойное ощущение Zen.
- Основной текст — `dark`, не абсолютный black.
- `coral` лучше работает как акцент: лого, выделенное слово, ссылка, иконка, CTA-деталь.
- На светлом фоне `coral`, `blue` и особенно `green` лучше не использовать для мелкого текста из-за контраста.
- Для карточек/hover/secondary button используй `subtle`/`muted`, чтобы интерфейс оставался мягким и не перегруженным.
- Для dark theme сохраняй тёплый `#D1CFC0` вместо чисто белого текста.

---

## 9. Mini UI recipe

```css
.page {
  background: var(--zen-paper);
  color: var(--zen-dark);
}

.logo,
.link,
.highlight {
  color: var(--zen-coral);
}

.button-primary {
  background: var(--zen-dark);
  color: var(--zen-paper);
  border-radius: 12px;
}

.button-secondary,
.card-soft {
  background: var(--zen-subtle);
  color: var(--zen-dark);
  border-radius: 12px;
}

.dropdown {
  background: var(--zen-paper);
  border: 2px solid var(--zen-dark);
}

.dropdown-item:hover {
  background: var(--zen-muted);
}
```

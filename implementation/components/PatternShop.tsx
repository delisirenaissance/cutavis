"use client";

// Start page: a header section plus every pattern as a "product" card with a
// two-picture carousel (design picture, then thumbnail). Clicking a card opens
// the pattern on the canvas page.

import { useState } from "react";

interface Props {
  patterns: string[];
  /** Display titles (the `name` field of the pattern files), by file name. */
  titles?: Record<string, string>;
  /** The pattern currently open in the editor (marked on its card). */
  currentPattern: string;
  /** True if the current pattern has unsaved changes. */
  currentDirty: boolean;
  onOpen: (name: string) => void;
  /** Error from loading a pattern, if any. */
  status?: string | null;
  /** The tailor-mode switch, shown top right. */
  tailorSwitch?: React.ReactNode;
}

const SLIDES = [
  { kind: "design", label: "Design" },
  { kind: "thumbnail", label: "Pattern" },
] as const;

function ProductCard({
  name,
  title,
  current,
  dirty,
  onOpen,
}: {
  name: string;
  /** Shown title (the pattern's `name` field, else the file name). */
  title: string;
  current: boolean;
  dirty: boolean;
  onOpen: () => void;
}) {
  const [slide, setSlide] = useState(0);
  const [missing, setMissing] = useState<Record<string, boolean>>({});
  const go = (e: React.MouseEvent, i: number) => {
    e.stopPropagation(); // carousel controls must not open the pattern
    setSlide((i + SLIDES.length) % SLIDES.length);
  };
  const s = SLIDES[slide];

  return (
    <article
      className={`product-card${current ? " current" : ""}`}
      onClick={onOpen}
      role="link"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
      title={`Open ${title}`}
    >
      <div className="product-carousel">
        {missing[s.kind] ? (
          <div className="product-placeholder">
            No {s.label.toLowerCase()} picture yet
            <code>
              {s.kind === "design" ? `patterndesigns/${name}Design.png` : `patternthumbnails/${name}Thumbnail.png`}
            </code>
          </div>
        ) : (
          <img
            key={s.kind}
            src={`/api/pattern-images/${s.kind}/${encodeURIComponent(name)}`}
            alt={`${title} — ${s.label}`}
            onError={() => setMissing((m) => ({ ...m, [s.kind]: true }))}
          />
        )}
        <span className="product-slide-label">{s.label}</span>
        <button className="carousel-btn prev" onClick={(e) => go(e, slide - 1)} aria-label="Previous picture">
          ‹
        </button>
        <button className="carousel-btn next" onClick={(e) => go(e, slide + 1)} aria-label="Next picture">
          ›
        </button>
        <div className="carousel-dots">
          {SLIDES.map((d, i) => (
            <button
              key={d.kind}
              className={`carousel-dot${i === slide ? " active" : ""}`}
              onClick={(e) => go(e, i)}
              aria-label={`Show ${d.label} picture`}
            />
          ))}
        </div>
      </div>
      <div className="product-info">
        <h3>{title}</h3>
      </div>
    </article>
  );
}

export function PatternShop({ patterns, titles = {}, currentPattern, currentDirty, onOpen, status, tailorSwitch }: Props) {
  return (
    <div className="shop">
      <header className="shop-hero">
        {tailorSwitch && <div className="shop-topbar">{tailorSwitch}</div>}
        <img width="15%" src="/imgs/logo.svg" alt="Logo"></img>
        <h1>delisi</h1>
        <h2>patterns made to measure</h2>
        <p>1. select a pattern.</p>
        <p>2. select your (saved) measurements</p>
        <p>3. print your pattern pdf - for free</p>
      </header>
      <section className="shop-grid-wrap">
        {status && <p className="reload-err">{status}</p>}
        {patterns.length === 0 ? (
          <p className="subtitle">No patterns found in patterndefinitions/.</p>
        ) : (
          <div className="shop-grid">
            {patterns.map((name) => (
              <ProductCard
                key={name}
                name={name}
                title={titles[name] || name}
                current={name === currentPattern}
                dirty={name === currentPattern && currentDirty}
                onOpen={() => onOpen(name)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

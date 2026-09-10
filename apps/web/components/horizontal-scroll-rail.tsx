"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState, type RefObject } from "react";

export function HorizontalScrollRail({
  scrollRef,
  label = "Scroll horizontally",
  className = "",
}: {
  scrollRef: RefObject<HTMLElement | null>;
  label?: string;
  className?: string;
}) {
  const [thumb, setThumb] = useState({ width: 100, left: 0 });
  const [scrollable, setScrollable] = useState(false);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const maxScroll = element.scrollWidth - element.clientWidth;
        if (maxScroll <= 0) {
          setScrollable(false);
          setThumb({ width: 100, left: 0 });
          return;
        }
        setScrollable(true);
        const width = Math.max(18, (element.clientWidth / element.scrollWidth) * 100);
        setThumb({ width, left: (element.scrollLeft / maxScroll) * (100 - width) });
      });
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [scrollRef]);

  if (!scrollable) return null;

  return (
    <button
      type="button"
      aria-label={label}
      className={`horizontal-scroll-rail ${className}`}
      onClick={(event) => {
        const element = scrollRef.current;
        if (!element) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        const target = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
        element.scrollTo({ left: target * (element.scrollWidth - element.clientWidth), behavior: "smooth" });
      }}
    >
      <span className="horizontal-scroll-rail__thumb" style={{ width: `${thumb.width}%`, left: `${thumb.left}%` }} />
    </button>
  );
}

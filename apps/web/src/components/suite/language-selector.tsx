"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { Lang } from "./common";

const languages = [
  { value: "en", label: "English", flag: "/flags/gb.svg" },
  { value: "id", label: "Bahasa Indonesia", flag: "/flags/id.svg" },
] as const;

export function LanguageSelector({
  value,
  onChange,
}: {
  value: Lang;
  onChange: (value: Lang) => void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const selected = languages.findIndex((language) => language.value === value);
  const [active, setActive] = useState(selected);

  useEffect(() => {
    if (!open) return;
    function dismiss(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  function choose(index: number) {
    onChange(languages[index].value);
    setOpen(false);
    trigger.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        setActive(
          open
            ? (active +
                (event.key === "ArrowDown" ? 1 : -1) +
                languages.length) %
                languages.length
            : selected,
        );
        setOpen(true);
        break;
      case "Home":
      case "End":
        event.preventDefault();
        setActive(event.key === "Home" ? 0 : languages.length - 1);
        setOpen(true);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (open) choose(active);
        else {
          setActive(selected);
          setOpen(true);
        }
        break;
      case "Escape":
        if (open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  }

  return (
    <div
      className="language-selector"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="secondary language-trigger"
        role="combobox"
        aria-label="Language"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-listbox`}
        aria-activedescendant={open ? `${id}-option-${active}` : undefined}
        onKeyDown={onKeyDown}
        onClick={() => {
          setActive(selected);
          setOpen(!open);
        }}
      >
        <span className="language-label">
          <img
            className="language-flag"
            src={languages[selected].flag}
            alt=""
            width={24}
            height={16}
          />
          <span>{languages[selected].label}</span>
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <ul
          id={`${id}-listbox`}
          role="listbox"
          aria-label="Language"
          className="language-options"
        >
          {languages.map((language, index) => (
            <li
              key={language.value}
              id={`${id}-option-${index}`}
              role="option"
              aria-selected={value === language.value}
              className={active === index ? "is-active" : undefined}
              onPointerMove={() => setActive(index)}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
              lang={language.value}
            >
              <span className="language-label">
                <img
                  className="language-flag"
                  src={language.flag}
                  alt=""
                  width={24}
                  height={16}
                />
                <span>{language.label}</span>
              </span>
              {value === language.value && (
                <Check size={16} aria-hidden="true" />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

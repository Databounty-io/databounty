"use client";

// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { Icon } from "./icons";

/**
 * Password input with a show/hide (eye) toggle. Drop-in for a plain
 * `<input type="password">` — forwards every input prop (value, onChange,
 * autoComplete, minLength, placeholder, etc.); pass the same `className` the
 * bare input used. The toggle only swaps the input `type`, so autofill and
 * password managers keep working. `tabIndex={-1}` keeps it out of the tab
 * order so keyboard users still tab straight from field to submit.
 */
export function PasswordInput({ className = "", ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input {...props} type={show ? "text" : "password"} className={`${className} pr-10`} />
      <button
        type="button"
        onClick={() => setShow((value) => !value)}
        aria-label={show ? "Hide password" : "Show password"}
        aria-pressed={show}
        tabIndex={-1}
        className="absolute inset-y-0 right-0 flex items-center pr-3 text-dark-dim transition-colors hover:text-dark-text"
      >
        <Icon name={show ? "eye-off" : "eye"} size={16} />
      </button>
    </div>
  );
}

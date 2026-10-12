import type { ReactNode } from "react";

/**
 * The chain's voice.
 *
 * Everything in this file is for a surface where the chain is speaking: a
 * digest, a phase, a ranking, a payment. It reads as a specification because
 * that is what it is, and it is deliberately a different register from the
 * display face and the prose around it. A reader should be able to tell which
 * half of a page they are in without reading a word.
 *
 * Square corners throughout. A radius is a softening and nothing about a digest
 * is soft.
 */

function join(...classes: (string | false | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

/**
 * A bracketed index and a name, the way a specification numbers its sections.
 *
 * The brackets are not decoration: they are the convention a reader of
 * technical documents already knows, and borrowing it says what kind of
 * document this is before the words do.
 */
export function SpecLabel({
  index,
  children,
}: {
  index?: string;
  children: ReactNode;
}) {
  return (
    <p className="label text-ink-faint">
      {index !== undefined && <span className="text-ink-soft">[{index}]</span>}
      {children}
    </p>
  );
}

/** A heading in the chain's voice: condensed, capitalised, tracked in. */
export function SpecHeading({
  children,
  className,
  large = false,
}: {
  children: ReactNode;
  className?: string;
  /** The page's own title, set at the size of an `h1`. */
  large?: boolean;
}) {
  return (
    <h2
      className={join(
        "technical",
        large ? "text-[clamp(2rem,4.5vw,3rem)]" : "text-[clamp(1.5rem,3vw,2.25rem)]",
        className,
      )}
    >
      {children}
    </h2>
  );
}

/**
 * The row, which is the whole layout.
 *
 * A numbered marker, a monospaced label, and the value. Full width hairlines
 * between them and nothing else: no cards, no shadows, no containers. A spec
 * sheet is a list of facts and the design's job is to stay out of the way of
 * comparing them.
 */
export function SpecRows({ children }: { children: ReactNode }) {
  return <div className="border-t border-rule">{children}</div>;
}

export function SpecRow({
  index,
  label,
  children,
  mark = false,
}: {
  index?: string;
  label: string;
  children: ReactNode;
  /**
   * The crosshair a technical drawing puts at a registration point.
   *
   * Used to mark the rows that carry a claim somebody might want to check,
   * rather than on every row, which would make it mean nothing.
   */
  mark?: boolean;
}) {
  return (
    <div className="relative grid items-baseline gap-2 border-b border-rule py-6 sm:grid-cols-[3rem_14rem_1fr] sm:gap-6">
      {index !== undefined && (
        <span className="label text-signal-deep dark:text-signal">{index}</span>
      )}

      <span className="label text-ink-faint">{label}</span>

      <div className="min-w-0 text-ink">{children}</div>

      {mark && (
        <span
          aria-hidden
          className="pointer-events-none absolute right-0 top-1/2 hidden -translate-y-1/2 text-ink-faint sm:block"
        >
          +
        </span>
      )}
    </div>
  );
}

/**
 * A value the chain holds, shown as it holds it.
 *
 * Monospaced and tabular, so a column of digests lines up and a changed
 * character is visible where it changed. That is the only way anybody actually
 * compares one.
 */
export function SpecValue({
  children,
  size = "md",
}: {
  children: ReactNode;
  size?: "md" | "lg";
}) {
  return (
    <span
      className={join(
        "tabular break-all",
        size === "lg" ? "text-[1.125rem]" : "text-[0.9375rem]",
      )}
    >
      {children}
    </span>
  );
}

/**
 * A square button, for actions on a chain surface.
 *
 * The same restraint as the rounded one and none of the softness. It sits
 * beside a spec sheet and should look like it belongs to the same document.
 */
export function SpecButton({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="label inline-flex h-9 items-center gap-2 bg-ink px-4 text-paper transition-colors duration-150 ease-settle hover:bg-ink/85 active:translate-y-px"
    >
      {children}
      <span aria-hidden>→</span>
    </a>
  );
}

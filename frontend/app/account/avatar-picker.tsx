"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { saveAvatar } from "./actions";
import { uploadAvatar } from "../../lib/avatar";

/**
 * The picture, changed where it is shown.
 *
 * It was a field in the form below with a button beside it reading "Change",
 * which is a control describing itself in a place nobody was looking. The
 * portrait at the top of the page is where somebody looks when they want to
 * change their picture, so that is where the control goes: the pencil says the
 * thing the button said, and it says it on the object it applies to.
 *
 * It saves on choosing rather than waiting for the form. A picture is not part
 * of the sentence the rest of that form writes — nothing else on the page has
 * to be valid for this one to be true — and a portrait that changed on screen
 * but only really changed after somebody scrolled down and pressed Save would
 * be lying for as long as it took them to find out.
 */

export function AvatarPicker({
  userId,
  src,
  name,
}: {
  userId: string;
  /** Whatever is being shown now: theirs, or the provider's, or neither. */
  src: string | null;
  name: string;
}) {
  const router = useRouter();
  const [shown, setShown] = useState(src);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const box = useRef<HTMLInputElement>(null);

  async function take(file: File | undefined) {
    if (file === undefined) {
      return;
    }

    setBusy(true);
    setRefused(null);

    const uploaded = await uploadAvatar(file, userId);

    if (uploaded.url === null) {
      setBusy(false);
      setRefused(uploaded.message);
      return;
    }

    const written = await saveAvatar(uploaded.url);

    setBusy(false);

    if (!written.ok) {
      setRefused(written.message);
      return;
    }

    setShown(uploaded.url);

    /* The header draws this picture too. Without the refresh it would keep the
       old one until the next navigation, which is the same person shown two
       ways on one screen. */
    router.refresh();
  }

  return (
    <div className="shrink-0">
      <input
        ref={box}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(event) => {
          void take(event.target.files?.[0]);
          /* Cleared so choosing the same file twice still fires, which is what
             somebody does after an upload fails. */
          event.target.value = "";
        }}
      />

      <button
        type="button"
        onClick={() => box.current?.click()}
        disabled={busy}
        aria-label="Change your picture"
        className="group relative block rounded-full"
      >
        {shown === null ? (
          <span
            aria-hidden
            className="grid size-16 place-items-center rounded-full bg-ink text-[1.5rem] font-semibold text-signal sm:size-20 sm:text-[1.75rem]"
          >
            {name.trim().charAt(0).toUpperCase()}
          </span>
        ) : (
          <img
            src={shown}
            alt=""
            width={80}
            height={80}
            referrerPolicy="no-referrer"
            className="size-16 rounded-full object-cover ring-1 ring-rule sm:size-20"
          />
        )}

        {/* Dimmed while the file is on its way, so the picture on screen is
            never the one that has already been replaced. */}
        {busy && (
          <span className="absolute inset-0 rounded-full bg-paper/70" aria-hidden />
        )}

        {/* The pencil sits on the rim rather than over the face, because a mark
            in the middle of a portrait covers the one thing the portrait is
            for. Paper ring around it so it reads as an object on top of the
            picture rather than a hole punched in it. */}
        <span
          aria-hidden
          className="absolute -bottom-0.5 -right-0.5 grid size-7 place-items-center rounded-full bg-ink text-paper ring-2 ring-paper transition-transform duration-150 ease-settle group-hover:scale-110"
        >
          <Pencil />
        </span>
      </button>

      {refused !== null && (
        <p className="mt-2 max-w-[14rem] text-[0.8125rem] leading-relaxed text-broken">
          {refused}
        </p>
      )}
    </div>
  );
}

function Pencil() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5"
    >
      <path d="M11.2 2.3a1.6 1.6 0 0 1 2.3 2.3l-7.4 7.4-3 .7.7-3 7.4-7.4Z" />
    </svg>
  );
}

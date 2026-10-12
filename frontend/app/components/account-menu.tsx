"use client";

import { useEffect, useRef, useState } from "react";

import Link from "next/link";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";

import { CommitButton } from "./commit-button";
import { Pop, Press } from "./motion";
import { browserClient } from "../../lib/supabase/client";
import { shorten, useWallet } from "./wallet-context";

/**
 * The one control on the right of the header, on every page.
 *
 * It used to be a pill reading "My account", which spent the widest object in
 * the header on two words a reader learns once and then never needs again. An
 * avatar says the same thing in the shape everybody already knows, and the
 * room it gives back is what lets the connected address sit beside it.
 *
 * Address and identity share this control rather than having one each. They
 * are different layers and the account page keeps them apart, but in a header
 * they answer the same question, which is who am I here as. Two controls side
 * by side made a reader choose between them before knowing what either was.
 *
 * The address is shown wherever somebody is, because it is the key that will
 * sign the next thing they do. A page where that is out of sight is a page
 * where somebody submits a project from an account they did not mean to use.
 */

export function AccountMenu({
  email,
  username,
  avatarUrl = null,
  organizer = false,
  staff = false,
}: {
  email: string | null;
  /** Absent when the profile could not be read, which costs the Profile row. */
  username?: string | null;
  /** The face this account chose, when it chose one. */
  avatarUrl?: string | null;
  /**
   * Whether this account may run events, which is the only place the product
   * advertises that it can. The header carries one link and it is Hackathons;
   * putting a second one up there for a capability almost nobody has would make
   * every reader choose between two destinations to learn that one of them is
   * not for them.
   */
  organizer?: boolean;
  /** Whether this account reviews applications. */
  staff?: boolean;
}) {
  const router = useRouter();
  const { wallet, known, connect, disconnect } = useWallet();

  /*
    How many hackathons name this wallet as a judge.

    Asked once per connected address rather than on every render, and only to
    decide whether a row appears. A judge is not a role in our tables: it is an
    address in a frozen constitution, so the only way to know is to read the
    rules, which is what the route behind this does.
  */
  const [judging, setJudging] = useState(0);

  useEffect(() => {
    const address = wallet?.address ?? null;

    if (address === null) {
      setJudging(0);
      return;
    }

    let alive = true;

    void fetch(`/api/judging?address=${address}`)
      .then((answer) => answer.json() as Promise<{ judging: unknown[] }>)
      .then((said) => alive && setJudging(said.judging.length))
      .catch(() => alive && setJudging(0));

    return () => {
      alive = false;
    };
  }, [wallet?.address]);
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const holder = useRef<HTMLDivElement>(null);

  /* Close on a click anywhere else, and on escape. A menu that can only be
     closed by the control that opened it is a menu people get stuck in. */
  useEffect(() => {
    if (!open) {
      return;
    }

    function away(event: MouseEvent) {
      if (!holder.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);

    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  /* Nobody signed in, so the header's job is to offer the way in and nothing
     else. Black and yellow rather than a quiet grey: it is the one control up
     here and it should look like a door from across the page. At the small
     size it was the same weight as the link beside it, which is the wrong
     answer for the only thing up here somebody has to press. */
  if (email === null) {
    return <CommitButton href="/login">Log In</CommitButton>;
  }

  async function signOut() {
    const db = browserClient();

    if (db === null) {
      return;
    }

    setLeaving(true);
    setOpen(false);
    await db.auth.signOut();

    /* Refresh rather than push. Every server component on the page read the
       session while rendering, so the page has to be asked again rather than
       navigated to. */
    router.refresh();
    setLeaving(false);
  }

  const attached = known && wallet !== null;

  return (
    <div ref={holder} className="relative flex items-center gap-2">
      {/*
        Offered in the open when there is no wallet, rather than only inside
        this menu.

        Connecting one is the difference between reading a hackathon and being
        able to enter it, and it was a row behind an avatar somebody had no
        reason to press. Once a wallet is attached the pill beside this says so
        and the row in the menu becomes "switch", so this disappears rather than
        becoming a second way to say the same thing.
      */}
      {known && wallet === null && (
        <button
          type="button"
          onClick={() => void connect()}
          className="hidden h-10 items-center gap-2 rounded-full px-3.5 text-[0.9375rem] text-ink ring-1 ring-inset ring-rule transition-colors duration-150 ease-settle hover:bg-paper-sunk sm:flex"
        >
          <WalletIcon />
          Connect wallet
        </button>
      )}

      <Press>
        {/* `layout` because the pill grows when a wallet turns up: the first
            read finishes after the header has already painted, and a control
            that jumps from one width to another reads as a fault where one
            that expands reads as an answer arriving. */}
        <motion.button
          layout
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={attached ? `Account, wallet ${wallet.address}` : "Account"}
          className={`flex h-10 items-center rounded-full transition-colors duration-150 ease-settle ${
            attached
              ? "gap-2 bg-paper-sunk pl-3.5 pr-1 text-ink ring-1 ring-inset ring-rule hover:bg-rule/60"
              : ""
          }`}
        >
          {attached && (
            <>
              <Icon id={wallet.id} name={wallet.wallet} />
              <span className="tabular text-[0.9375rem]">{shorten(wallet.address)}</span>
            </>
          )}

          <Avatar email={email} avatarUrl={avatarUrl} />
        </motion.button>
      </Press>

      <Pop open={open} className="absolute right-0 top-13 z-20 w-[17rem] origin-top-right">
        {/*
          A list of places to go, which is what a menu under an avatar is.

          It described a state before: who you are, whether a wallet is
          attached, what that means, and two controls at the bottom. All of it
          true, and all of it a paragraph to read before finding the one word
          somebody opened this for. The state lives on the profile page, which
          is the first line of this list.

          An icon on each row rather than text alone. A menu of three is
          recognised by shape long before it is read, and the shapes are what
          make the destructive one look different from the two that are not.
        */}
        <div className="overflow-hidden rounded-[0.875rem] bg-paper py-1.5 shadow-[0_18px_40px_-24px_oklch(19%_0.008_60/0.5)] ring-1 ring-rule">
          {/* Two rows where there was one, because there are two pages: the
              profile is what other people see and settings is where it is
              written. A single row called Profile that opened a form was the
              menu describing one and going to the other. */}
          {typeof username === "string" && username.length > 0 && (
            <Link
              href={`/u/${username}`}
              onClick={() => setOpen(false)}
              className="flex w-full items-center gap-3 px-3.5 py-2.5 text-[1rem] text-ink transition-colors duration-150 ease-settle hover:bg-paper-sunk"
            >
              <Person />
              <span className="flex-1 truncate">Profile</span>
              <Chevron />
            </Link>
          )}

          <Link
            href="/account"
            onClick={() => setOpen(false)}
            className="flex w-full items-center gap-3 px-3.5 py-2.5 text-[1rem] text-ink transition-colors duration-150 ease-settle hover:bg-paper-sunk"
          >
            <Sliders />
            <span className="flex-1 truncate">Settings</span>
            <Chevron />
          </Link>

          {/* The rows somebody has and almost nobody else does, kept in their
              own band so the menu still reads as three things for the reader
              who has none of them. */}
          {(organizer || staff || judging > 0) && (
            <div className="my-1.5 border-t border-rule pt-1.5">
              {/* A judge is an address in a frozen document rather than a role
                  in our tables, so this row is decided by what the connected
                  wallet is named in and appears for somebody who has no grant
                  from us at all. Without it a judge's only way in was a link
                  the organizer sent them once. */}
              {judging > 0 && (
                <Link
                  href="/judge"
                  onClick={() => setOpen(false)}
                  className="flex w-full items-center gap-3 px-3.5 py-2.5 text-[1rem] text-ink transition-colors duration-150 ease-settle hover:bg-paper-sunk"
                >
                  <Gavel />
                  <span className="flex-1 truncate">Judging</span>
                  <Chevron />
                </Link>
              )}

              {organizer && (
                <Link
                  href="/manage"
                  onClick={() => setOpen(false)}
                  className="flex w-full items-center gap-3 px-3.5 py-2.5 text-[1rem] text-ink transition-colors duration-150 ease-settle hover:bg-paper-sunk"
                >
                  <Stage />
                  <span className="flex-1 truncate">Management Panel</span>
                  <Chevron />
                </Link>
              )}

              {staff && (
                <Link
                  href="/admin/organizers"
                  onClick={() => setOpen(false)}
                  className="flex w-full items-center gap-3 px-3.5 py-2.5 text-[1rem] text-ink transition-colors duration-150 ease-settle hover:bg-paper-sunk"
                >
                  <Tray />
                  <span className="flex-1 truncate">Applications</span>
                  <Chevron />
                </Link>
              )}
            </div>
          )}

          {/* The wallet is a row here rather than a panel, and what it says is
              what pressing it does. Whether one is attached is on the profile
              page and in the pill this menu hangs from, so a third telling of
              it would be the one that goes stale. */}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              void connect();
            }}
            className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-[1rem] text-ink transition-colors duration-150 ease-settle hover:bg-paper-sunk"
          >
            <WalletIcon />
            <span className="flex-1 truncate">{attached ? "Switch wallet" : "Connect a wallet"}</span>
            <Chevron />
          </button>

          {attached && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                void disconnect();
              }}
              className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-[1rem] text-ink-soft transition-colors duration-150 ease-settle hover:bg-paper-sunk hover:text-ink"
            >
              <Unplug />
              <span className="flex-1 truncate">Disconnect</span>
            </button>
          )}

          {/* Signing out lives beside what it undoes rather than only on the
              account page, which is a page somebody has to reach first. Red,
              because it is the one row here that cannot be undone by pressing
              it again. */}
          <div className="mt-1.5 border-t border-rule pt-1.5">
            <button
              type="button"
              disabled={leaving}
              onClick={() => void signOut()}
              className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-[1rem] text-danger transition-colors duration-150 ease-settle hover:bg-danger/10 disabled:opacity-50"
            >
              <Exit />
              <span className="flex-1 truncate">{leaving ? "Signing out" : "Sign out"}</span>
            </button>
          </div>
        </div>
      </Pop>
    </div>
  );
}

/* The row marks. Stroked rather than filled, at the weight of the text they
   sit beside, so a row reads as one object rather than as a symbol and a
   label. */

function Person() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="size-[1.125rem] shrink-0">
      <circle cx="10" cy="6.5" r="3.25" />
      <path d="M3.75 16.25c0-3 2.8-5 6.25-5s6.25 2 6.25 5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Sliders rather than a cog.
 *
 * A cog was here and it could not be drawn at this size. Eight teeth close the
 * gaps between them and fill in to a disc; four teeth read as a sun. Both were
 * heavier than every other mark in the menu, and one of them meant something
 * else entirely. Sliders say the same thing and survive being small.
 */
function Sliders() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="size-[1.125rem] shrink-0">
      <path d="M3 6h3.25M9.75 6H17M3 14h7.25M13.75 14H17" />
      <circle cx="8" cy="6" r="1.75" />
      <circle cx="12" cy="14" r="1.75" />
    </svg>
  );
}

/** A flag on a post: the thing an organizer plants, rather than a thing they own. */
function Stage() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="size-[1.125rem] shrink-0">
      <path d="M5.5 17V3.75" />
      <path d="M5.5 4.25h7.75l-1.5 2.75 1.5 2.75H5.5" />
    </svg>
  );
}

/** A gavel, for the one role the chain hands out rather than we do. */
function Gavel() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="size-[1.125rem] shrink-0">
      <path d="M4 16.5h7" />
      <path d="M7.5 13.5 13 8" />
      <path d="m10.75 4.5 4.75 4.75" />
      <path d="m12.5 2.75 4.75 4.75-1.75 1.75-4.75-4.75z" />
    </svg>
  );
}

/** A tray with something waiting in it. */
function Tray() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="size-[1.125rem] shrink-0">
      <path d="M3.25 11.75h3.5a3.25 3.25 0 0 0 6.5 0h3.5" />
      <path d="M3.25 11.75 5 4.75h10l1.75 7v2.5a1.5 1.5 0 0 1-1.5 1.5h-10.5a1.5 1.5 0 0 1-1.5-1.5v-2.5Z" />
    </svg>
  );
}

function WalletIcon() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="size-[1.125rem] shrink-0">
      <path d="M3.25 6.5A1.75 1.75 0 0 1 5 4.75h9A1.75 1.75 0 0 1 15.75 6.5v.75" strokeLinecap="round" />
      <rect x="3.25" y="6.5" width="13.5" height="8.75" rx="1.75" />
      <circle cx="13.25" cy="10.875" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function Unplug() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="size-[1.125rem] shrink-0">
      <path d="M7.5 3v3.5M12.5 3v3.5" />
      <path d="M5.75 6.5h8.5v3.25a4.25 4.25 0 0 1-8.5 0V6.5Z" />
      <path d="M10 14v3" />
    </svg>
  );
}

function Exit() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="size-[1.125rem] shrink-0">
      <path d="M12 3.75H5.75a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1H12" />
      <path d="M13.5 7.25 16.25 10l-2.75 2.75M16 10H8.5" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="size-4 shrink-0 text-ink-faint">
      <path d="m8 5 5 5-5 5" />
    </svg>
  );
}

/**
 * The person, as a circle with their initial in it.
 *
 * The initial rather than a stock silhouette, because two accounts on the same
 * machine look identical as silhouettes and this is the control somebody checks
 * before signing something. It falls back to a drawn figure only when there is
 * no address to take a letter from, which is a state the header should survive
 * rather than one it should be designed around.
 */
function Avatar({ email, avatarUrl }: { email: string; avatarUrl: string | null }) {
  const initial = email.trim().charAt(0).toUpperCase();

  /* The picture when there is one, and it was not being asked for: the profile
     page drew it and the header drew an initial, so the same person had two
     faces on one screen. */
  if (avatarUrl !== null) {
    return (
      <img
        aria-hidden
        src={avatarUrl}
        alt=""
        /* Google's picture host refuses some requests that name the page they
           came from, and this is often a Google picture. */
        referrerPolicy="no-referrer"
        className="size-9 shrink-0 rounded-full object-cover ring-1 ring-inset ring-rule"
      />
    );
  }

  return (
    <span
      aria-hidden
      className="grid size-9 shrink-0 place-items-center rounded-full bg-ink text-[0.9375rem] font-semibold text-signal"
    >
      {initial === "" ? <Figure /> : initial}
    </span>
  );
}

/** A shoulders and head silhouette, drawn rather than fetched. */
function Figure() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" fill="currentColor" className="size-4">
      <circle cx="8" cy="5.4" r="2.8" />
      <path d="M8 9.4c-3 0-5.2 1.8-5.2 4.1 0 .3.2.5.5.5h9.4c.3 0 .5-.2.5-.5 0-2.3-2.2-4.1-5.2-4.1Z" />
    </svg>
  );
}

/**
 * The wallet's own mark, so the pill says which one at a glance.
 *
 * Served from here rather than from the kit's `productIcon`, which points at
 * creit.tech. That URL would make the header fetch an image from a third party
 * on every page a connected person opens, and tell them about it each time.
 */
const drawn = new Set(["freighter", "albedo", "xbull", "lobstr"]);

function Icon({ id, name }: { id: string; name: string }) {
  if (!drawn.has(id)) {
    /* A wallet added later has no file here yet. A dot keeps the pill the same
       shape rather than collapsing it. */
    return <span aria-hidden className="size-4 rounded-full bg-ink-faint" />;
  }

  return (
    <img
      src={`/wallets/${id}.png`}
      alt={name}
      width={16}
      height={16}
      className="size-4 rounded-[0.2rem]"
    />
  );
}
